import * as vscode from 'vscode'
import * as Y from 'yjs'
import WebSocket from 'ws'
import { isWikiDocument, workspaceRoot } from '../workspace'

function encode(value: Uint8Array): string { return Buffer.from(value).toString('base64') }
function decode(value: string): Uint8Array { return new Uint8Array(Buffer.from(value, 'base64')) }

export class CollaborationClient implements vscode.Disposable {
  private socket: WebSocket | undefined
  private readonly ydoc = new Y.Doc()
  private readonly text = this.ydoc.getText('markdown')
  private applyingRemote = false
  private document: vscode.TextDocument | undefined
  private readonly disposables: vscode.Disposable[] = []

  async join(document = vscode.window.activeTextEditor?.document): Promise<void> {
    if (!document || !isWikiDocument(document)) return void vscode.window.showWarningMessage('Open a Wiki Markdown file before joining collaboration.')
    this.document = document
    if (this.text.length === 0) this.ydoc.transact(() => this.text.insert(0, document.getText()))
    const baseUrl = vscode.workspace.getConfiguration('pyroWiki').get<string>('apiBaseUrl', 'http://127.0.0.1:8787').replace(/^http/, 'ws')
    const root = workspaceRoot(document)!
    const workspaceId = encodeURIComponent(root.split(/[\\/]/).pop()!.replace(/[^A-Za-z0-9_-]/g, '-').toLowerCase())
    const documentPath = encodeURIComponent(document.uri.fsPath.slice(root.length).replace(/^[\\/]+/, '').replaceAll('\\', '/'))
    this.socket?.close()
    this.socket = new WebSocket(`${baseUrl}/collaboration/${documentPath}?workspace=${workspaceId}`)
    this.socket.on('open', () => {
      this.send({ type: 'hello', state: encode(Y.encodeStateAsUpdate(this.ydoc)), user: vscode.env.machineId.slice(0, 8) })
      this.send({ type: 'awareness', user: vscode.env.machineId.slice(0, 8), status: 'online' })
    })
    this.socket.on('message', (data) => this.receive(data.toString()))
    this.socket.on('close', () => void vscode.window.showInformationMessage('PYRo Wiki collaboration disconnected; edits remain local.'))
    this.socket.on('error', (error) => void vscode.window.showWarningMessage(`Collaboration connection error: ${error.message}`))
    this.disposables.push(vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() !== document.uri.toString() || this.applyingRemote) return
      this.ydoc.transact(() => {
        this.text.delete(0, this.text.length)
        this.text.insert(0, event.document.getText())
      }, 'vscode')
    }))
    this.disposables.push({ dispose: () => this.ydoc.destroy() })
    this.ydoc.on('update', (update: Uint8Array, origin: unknown) => { if (origin !== 'remote') this.send({ type: 'update', update: encode(update) }) })
    void vscode.window.showInformationMessage('Joined PYRo Wiki collaboration room.')
  }

  private send(message: Record<string, unknown>): void { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)) }

  private receive(raw: string): void {
    try {
      const message = JSON.parse(raw) as { type: string; update?: string; state?: string }
      if ((message.type === 'sync' || message.type === 'update') && message.update) {
        this.applyingRemote = true
        Y.applyUpdate(this.ydoc, decode(message.update), 'remote')
        if (this.document && this.document.getText() !== this.text.toString()) {
          const edit = new vscode.WorkspaceEdit()
          edit.replace(this.document.uri, new vscode.Range(0, 0, this.document.lineCount, this.document.lineAt(this.document.lineCount - 1).text.length), this.text.toString())
          void vscode.workspace.applyEdit(edit)
        }
        this.applyingRemote = false
      }
    } catch { /* malformed peer messages are ignored */ }
  }

  dispose(): void { this.socket?.close(); for (const disposable of this.disposables) disposable.dispose(); this.ydoc.destroy() }
}
