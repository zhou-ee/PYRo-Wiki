import * as vscode from 'vscode'
import * as Y from 'yjs'
import WebSocket from 'ws'
import { isWikiDocument, workspaceRoot } from '../workspace'
import type { AuthManager } from '../auth/session'

function encode(value: Uint8Array): string { return Buffer.from(value).toString('base64') }
function decode(value: string): Uint8Array { return new Uint8Array(Buffer.from(value, 'base64')) }

export type CollaborationStatus = 'offline' | 'connecting' | 'connected' | 'reconnecting' | 'error'
export interface CollaborationSnapshot {
  status: CollaborationStatus
  documentPath?: string
  users: string[]
  error?: string
  events: string[]
}

const HEARTBEAT_INTERVAL_MS = 20_000
const HEARTBEAT_TIMEOUT_MS = 65_000

export class CollaborationClient implements vscode.Disposable {
  private socket: WebSocket | undefined
  private readonly ydoc = new Y.Doc()
  private readonly text = this.ydoc.getText('markdown')
  private applyingRemote = false
  private document: vscode.TextDocument | undefined
  private documentListener: vscode.Disposable | undefined
  private reconnectTimer: NodeJS.Timeout | undefined
  private heartbeatTimer: NodeJS.Timeout | undefined
  private reconnectAttempt = 0
  private connectionGeneration = 0
  private lastMessageAt = 0
  private intentionalClose = false
  private readonly users = new Map<string, string>()
  private readonly events: string[] = []
  private readonly disposables: vscode.Disposable[] = []
  private readonly changeEmitter = new vscode.EventEmitter<CollaborationSnapshot>()
  private snapshot: CollaborationSnapshot = { status: 'offline', users: [], events: [] }

  readonly onDidChange = this.changeEmitter.event

  constructor(private readonly auth: AuthManager) {
    this.disposables.push(this.changeEmitter)
    this.ydoc.on('update', this.handleYjsUpdate)
  }

  get state(): CollaborationSnapshot { return this.snapshot }

  private userNames(): string[] { return [...this.users.values()].sort((left, right) => left.localeCompare(right)) }

  async join(document = vscode.window.activeTextEditor?.document): Promise<void> {
    if (!document || !isWikiDocument(document)) return void vscode.window.showWarningMessage('Open a Wiki Markdown file before joining collaboration.')
    const token = await this.auth.getAccessToken()
    if (!token) return void vscode.window.showWarningMessage('Sign in with Feishu before joining collaboration.')
    await this.leave(false)
    this.document = document
    this.intentionalClose = false
    this.reconnectAttempt = 0
    this.users.clear()
    this.events.length = 0
    this.recordEvent(`Joining ${document.fileName}`)
    this.ydoc.transact(() => {
      this.text.delete(0, this.text.length)
      this.text.insert(0, document.getText())
    }, 'vscode-initial')
    this.documentListener = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() !== document.uri.toString() || this.applyingRemote) return
      this.ydoc.transact(() => {
        this.text.delete(0, this.text.length)
        this.text.insert(0, event.document.getText())
      }, 'vscode')
    })
    this.connect()
  }

  private readonly handleYjsUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === 'remote' || origin === 'vscode-initial' || this.applyingRemote) return
    this.send({ type: 'update', update: encode(update) })
  }

  private connect(): void {
    if (!this.document) return
    const root = workspaceRoot(this.document)
    if (!root) return
    const generation = ++this.connectionGeneration
    const baseUrl = vscode.workspace.getConfiguration('pyroWiki').get<string>('apiBaseUrl', 'https://pyro-wiki-api.luckyy.ccwu.cc').replace(/^http/, 'ws')
    const workspaceId = encodeURIComponent(root.split(/[\\/]/).pop()!.replace(/[^A-Za-z0-9_-]/g, '-').toLowerCase())
    const documentPath = encodeURIComponent(this.document.uri.fsPath.slice(root.length).replace(/^[\\/]+/, '').replaceAll('\\', '/'))
    const decodedPath = decodeURIComponent(documentPath)
    const url = `${baseUrl}/collaboration/${documentPath}?workspace=${workspaceId}`
    this.update({ status: this.reconnectAttempt ? 'reconnecting' : 'connecting', documentPath: decodedPath, users: this.userNames() })
    void this.auth.getAccessToken().then((token) => {
      if (!token || !this.document || generation !== this.connectionGeneration || this.intentionalClose) return
      const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } })
      this.socket = socket
      socket.on('open', () => {
        if (generation !== this.connectionGeneration) return void socket.close(1000, 'stale connection')
        this.reconnectAttempt = 0
        this.lastMessageAt = Date.now()
        this.startHeartbeat(socket)
        this.update({ status: 'connected', documentPath: decodedPath, users: this.userNames() })
        this.recordEvent('Connected to collaboration room')
        this.send({ type: 'hello', state: encode(Y.encodeStateAsUpdate(this.ydoc)) })
        this.send({ type: 'awareness', status: 'online' })
      })
      socket.on('message', (data) => {
        this.lastMessageAt = Date.now()
        this.receive(data.toString())
      })
      socket.on('close', () => {
        if (this.socket === socket) this.socket = undefined
        this.stopHeartbeat()
        if (generation !== this.connectionGeneration) return
        if (!this.intentionalClose && this.document) {
          this.recordEvent('Connection closed; scheduling reconnect')
          this.scheduleReconnect()
        } else if (this.intentionalClose) {
          this.update({ status: 'offline', users: [] })
          this.recordEvent('Left collaboration room')
        }
      })
      socket.on('error', (error) => {
        if (generation !== this.connectionGeneration) return
        this.update({ status: 'error', documentPath: decodedPath, users: this.userNames(), error: error.message })
        this.recordEvent(`Socket error: ${error.message}`, error.message)
      })
    }).catch((error) => {
      if (generation === this.connectionGeneration && !this.intentionalClose) {
        const message = error instanceof Error ? error.message : String(error)
        this.update({ status: 'error', documentPath: decodedPath, users: this.userNames(), error: message })
        this.recordEvent(`Authentication/connection error: ${message}`, message)
      }
    })
  }

  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return
      if (Date.now() - this.lastMessageAt > HEARTBEAT_TIMEOUT_MS) return void socket.terminate()
      socket.send(JSON.stringify({ type: 'ping' }))
    }, HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.document) return
    this.reconnectAttempt += 1
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempt - 1, 5))
    const retryMessage = `Retrying in ${Math.ceil(delay / 1000)}s`
    this.update({ status: 'reconnecting', documentPath: this.snapshot.documentPath, users: this.userNames(), error: retryMessage })
    this.recordEvent(`Reconnect scheduled (${Math.ceil(delay / 1000)}s)`, retryMessage)
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; this.connect() }, delay)
  }

  async leave(showMessage = true): Promise<void> {
    this.intentionalClose = true
    this.connectionGeneration += 1
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined }
    this.stopHeartbeat()
    this.socket?.close(1000, 'client leaving')
    this.socket = undefined
    this.documentListener?.dispose()
    this.documentListener = undefined
    this.document = undefined
    this.users.clear()
    this.update({ status: 'offline', users: [] })
    this.recordEvent('Left collaboration room')
    if (showMessage) void vscode.window.showInformationMessage('Left PYRo Wiki collaboration.')
  }

  private send(message: Record<string, unknown>): void { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)) }

  private receive(raw: string): void {
    try {
      const message = JSON.parse(raw) as { type: string; update?: string; presenceId?: string; userId?: string; user?: string; status?: string; error?: string }
      if (message.type === 'pong') return
      if (message.type === 'sync' || message.type === 'update') {
        if (!message.update) return
        this.applyingRemote = true
        try {
          Y.applyUpdate(this.ydoc, decode(message.update), 'remote')
          this.recordEvent(message.type === 'sync' ? 'Received initial Yjs state' : 'Received remote Yjs update')
          if (this.document && this.document.getText() !== this.text.toString()) {
            const edit = new vscode.WorkspaceEdit()
            const endLine = Math.max(0, this.document.lineCount - 1)
            edit.replace(this.document.uri, new vscode.Range(0, 0, endLine, this.document.lineAt(endLine).text.length), this.text.toString())
            void vscode.workspace.applyEdit(edit)
          }
        } finally {
          this.applyingRemote = false
        }
      } else if (message.type === 'awareness' && message.user) {
        const presenceId = message.presenceId ?? message.userId ?? message.user
        if (message.status === 'offline') {
          this.users.delete(presenceId)
          this.recordEvent(`${message.user} left the room`)
        } else {
          this.users.set(presenceId, message.user)
          this.recordEvent(`${message.user} is online`)
        }
      } else if (message.type === 'error') {
        const error = message.error ?? 'Collaboration server error'
        this.update({ status: 'error', documentPath: this.snapshot.documentPath, users: this.userNames(), error })
        this.recordEvent(`Server error: ${error}`, error)
      }
    } catch { /* malformed peer messages are ignored */ }
  }

  private update(next: Omit<CollaborationSnapshot, 'events'>): void {
    this.snapshot = { ...next, events: [...this.events] }
    this.changeEmitter.fire(this.snapshot)
  }

  private recordEvent(message: string, error = this.snapshot.error): void {
    this.events.unshift(`${new Date().toLocaleTimeString()} ${message}`)
    this.events.splice(8)
    this.update({ status: this.snapshot.status, documentPath: this.snapshot.documentPath, users: this.userNames(), error })
  }

  dispose(): void {
    void this.leave(false)
    this.ydoc.off('update', this.handleYjsUpdate)
    this.ydoc.destroy()
    for (const disposable of this.disposables) disposable.dispose()
  }
}
