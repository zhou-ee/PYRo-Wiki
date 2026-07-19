import * as Y from 'yjs'
import { authenticateRequest, handleAuthRequest, isAuthResponse, type AuthEnv, type AuthUser } from './auth'
import { decideRevisionWrite, isRevisionConstraintError } from './testable'

export interface Env extends AuthEnv {
  COLLABORATION_ROOM: DurableObjectNamespace
}

type JsonRecord = Record<string, unknown>
type SocketPresence = { presenceId: string; userId: string; name: string }

const MAX_REQUEST_BYTES = 2_000_000
const MAX_COLLAB_MESSAGE_BYTES = 4_000_000

function json(body: JsonRecord, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET,PUT,POST,OPTIONS' } })
}
function error(message: string, status = 400): Response { return json({ error: message }, status) }
function now(): string { return new Date().toISOString() }
function idFor(workspace: string, path: string): string { return `${workspace}:${path}` }
function normalizePath(value: string): string { return decodeURIComponent(value).replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+/g, '/').replace(/(^|\/)\.\.(?=\/|$)/g, '').replace(/^\/+/, '').trim() }
function titleFor(path: string): string { return path.split('/').pop() || path }

async function body<T extends JsonRecord>(request: Request): Promise<T> {
  const length = Number(request.headers.get('content-length') ?? 0)
  if (length > MAX_REQUEST_BYTES) throw new Error('Document exceeds the 2 MB limit')
  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) throw new Error('Document exceeds the 2 MB limit')
  try { return JSON.parse(raw) as T } catch { throw new Error('Invalid JSON request body') }
}

async function ensureWorkspace(db: D1Database, workspace: string): Promise<void> {
  await db.prepare('INSERT OR IGNORE INTO workspaces (id, name) VALUES (?, ?)').bind(workspace, workspace).run()
}

async function ensureDocument(db: D1Database, workspace: string, documentPath: string): Promise<void> {
  await ensureWorkspace(db, workspace)
  await db.prepare('INSERT OR IGNORE INTO documents (id, workspace_id, path, title) VALUES (?, ?, ?, ?)').bind(idFor(workspace, documentPath), workspace, documentPath, titleFor(documentPath)).run()
}

async function readDocument(db: D1Database, workspace: string, documentPath: string): Promise<JsonRecord> {
  await ensureDocument(db, workspace, documentPath)
  const row = await db.prepare(`SELECT d.path, d.title, d.current_revision as revision, d.updated_at as updatedAt,
      COALESCE(r.content, '') as content
      FROM documents d LEFT JOIN revisions r ON r.document_id=d.id AND r.revision=d.current_revision
      WHERE d.id=?`).bind(idFor(workspace, documentPath)).first<JsonRecord>()
  if (!row) throw new Error('Document not found')
  return row
}

async function listDocuments(db: D1Database, workspace: string): Promise<JsonRecord[]> {
  await ensureWorkspace(db, workspace)
  const result = await db.prepare(`SELECT d.path, d.title, d.current_revision as revision, d.updated_at as updatedAt
      FROM documents d
      WHERE d.workspace_id=? ORDER BY d.path`).bind(workspace).all<JsonRecord>()
  return result.results ?? []
}

async function revisionConflict(db: D1Database, workspace: string, documentPath: string, content: string, baseRevision: number): Promise<Response> {
  const remote = await readDocument(db, workspace, documentPath)
  const common = baseRevision > 0 ? await db.prepare(`SELECT content, revision, created_at as updatedAt FROM revisions WHERE document_id=? AND revision=?`).bind(idFor(workspace, documentPath), baseRevision).first<JsonRecord>() : null
  return json({ error: 'Document changed remotely', local: { content, revision: baseRevision }, remote, common }, 409)
}

async function writeDocument(db: D1Database, workspace: string, documentPath: string, content: string, baseRevision: number, kind: 'published' | 'draft', authorId: string, message?: string): Promise<JsonRecord | Response> {
  await ensureDocument(db, workspace, documentPath)
  const current = await db.prepare('SELECT current_revision as revision FROM documents WHERE id=?').bind(idFor(workspace, documentPath)).first<{ revision: number }>()
  const revision = Number(current?.revision ?? 0)
  const decision = decideRevisionWrite(revision, baseRevision)
  if (decision.kind === 'conflict') return revisionConflict(db, workspace, documentPath, content, baseRevision)
  const next = decision.nextRevision!
  const documentId = idFor(workspace, documentPath)
  const revisionId = crypto.randomUUID()
  await db.batch([
    db.prepare('INSERT INTO revisions (id, document_id, revision, content, kind, message, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(revisionId, documentId, next, content, kind, message ?? null, authorId, now()),
    db.prepare('UPDATE documents SET current_revision=?, updated_at=? WHERE id=?').bind(next, now(), documentId)
  ])
  return readDocument(db, workspace, documentPath)
}

export class CollaborationRoom {
  private readonly doc = new Y.Doc()
  private loaded = false
  private loading: Promise<void> | undefined
  private readonly socketUsers = new Map<WebSocket, SocketPresence>()

  constructor(private readonly state: DurableObjectState, _env: Env) {}

  private loadOnce(): Promise<void> {
    if (this.loading) return this.loading
    this.loading = this.state.storage.get<ArrayBuffer>('yjs-state').then((stored) => {
      if (stored) Y.applyUpdate(this.doc, new Uint8Array(stored))
      this.loaded = true
    })
    return this.loading
  }

  private persist(): void {
    const encoded = Y.encodeStateAsUpdate(this.doc)
    this.state.waitUntil(this.state.storage.put('yjs-state', encoded.buffer))
  }

  private broadcast(message: JsonRecord, except?: WebSocket): void {
    const encoded = JSON.stringify(message)
    for (const socket of this.state.getWebSockets()) if (socket !== except) {
      try { socket.send(encoded) } catch { socket.close(1011, 'broadcast failed') }
    }
  }

  private handleMessage(server: WebSocket, raw: string | ArrayBuffer): void {
    try {
      const rawText = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
      if (new TextEncoder().encode(rawText).byteLength > MAX_COLLAB_MESSAGE_BYTES) throw new Error('Collaboration message is too large')
      const message = JSON.parse(rawText) as JsonRecord
      if (message.type === 'ping') {
        server.send(JSON.stringify({ type: 'pong' }))
      } else if (message.type === 'hello') {
        if (typeof message.state === 'string') {
          if (message.state.length > MAX_COLLAB_MESSAGE_BYTES) throw new Error('Collaboration state is too large')
          Y.applyUpdate(this.doc, fromBase64(message.state))
        }
        this.persist()
        const presence = this.socketUsers.get(server)
        if (!presence) return server.send(JSON.stringify({ type: 'error', error: 'Collaboration identity unavailable' }))
        const awareness = { type: 'awareness', presenceId: presence.presenceId, userId: presence.userId, user: presence.name, status: 'online' }
        server.send(JSON.stringify({ type: 'sync', update: toBase64(Y.encodeStateAsUpdate(this.doc)) }))
        server.send(JSON.stringify(awareness))
        this.broadcast(awareness, server)
      } else if (message.type === 'update' && typeof message.update === 'string') {
        if (message.update.length > MAX_COLLAB_MESSAGE_BYTES) throw new Error('Collaboration update is too large')
        const update = fromBase64(message.update)
        Y.applyUpdate(this.doc, update)
        this.persist()
        this.broadcast({ type: 'update', update: toBase64(update) }, server)
        server.send(JSON.stringify({ type: 'ack' }))
      } else if (message.type === 'awareness') {
        const presence = this.socketUsers.get(server)
        if (!presence) return
        const awareness = { type: 'awareness', presenceId: presence.presenceId, userId: presence.userId, user: presence.name, status: message.status === 'offline' ? 'offline' : 'online' }
        if (awareness.status === 'online') server.send(JSON.stringify(awareness))
        this.broadcast(awareness, server)
      }
    } catch { server.send(JSON.stringify({ type: 'error', error: 'Invalid collaboration message' })) }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'WebSocket upgrade required' }, 426)
    const userId = request.headers.get('x-pyro-user-id')
    const userName = request.headers.get('x-pyro-user-name')
    if (!userId || !userName) return json({ error: 'Collaboration authentication required' }, 401)
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.socketUsers.set(server, { presenceId: crypto.randomUUID(), userId, name: userName })
    this.state.acceptWebSocket(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  webSocketMessage(server: WebSocket, message: string | ArrayBuffer): void {
    this.state.waitUntil(this.loadOnce().then(() => this.handleMessage(server, message)))
  }

  webSocketClose(server: WebSocket): void {
    const presence = this.socketUsers.get(server)
    this.socketUsers.delete(server)
    if (presence) this.broadcast({ type: 'awareness', presenceId: presence.presenceId, userId: presence.userId, user: presence.name, status: 'offline' }, server)
  }

  webSocketError(server: WebSocket): void {
    try { server.close(1011, 'socket error') } catch { /* already closed */ }
  }
}
function toBase64(value: Uint8Array): string { return btoa(String.fromCharCode(...value)) }
function fromBase64(value: string): Uint8Array { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)) }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET,PUT,POST,OPTIONS' } })
    const authResponse = await handleAuthRequest(request, env)
    if (authResponse) return authResponse
    const url = new URL(request.url)
    if (url.pathname === '/health') return json({ ok: true, environment: env.PYRO_ENVIRONMENT, authMode: env.PYRO_AUTH_MODE, time: now() })
    const authenticated = await authenticateRequest(request, env)
    if (isAuthResponse(authenticated)) return authenticated
    if (url.pathname === '/authors' && request.method === 'GET') {
      const authors = await env.DB.prepare('SELECT id, name, avatar, title, description, links_json as links FROM authors ORDER BY name').all<JsonRecord>()
      return json({ authors: authors.results ?? [] })
    }
    if (url.pathname.startsWith('/collaboration/')) {
      const documentPath = normalizePath(url.pathname.slice('/collaboration/'.length))
      const workspace = url.searchParams.get('workspace') || 'default'
      const id = env.COLLABORATION_ROOM.idFromName(idFor(workspace, documentPath))
      const forwarded = new Request(request, { headers: new Headers(request.headers) })
      forwarded.headers.set('x-pyro-user-id', authenticated.id)
      forwarded.headers.set('x-pyro-user-name', authenticated.name)
      return env.COLLABORATION_ROOM.get(id).fetch(forwarded)
    }
    if (url.pathname === '/documents' && request.method === 'GET') {
      const workspace = url.searchParams.get('workspace') || 'default'
      return json({ documents: await listDocuments(env.DB, workspace) })
    }
    if (url.pathname.startsWith('/documents/')) {
      const suffix = url.pathname.slice('/documents/'.length)
      const isDraft = suffix.endsWith('/drafts')
      const isRevisions = suffix.endsWith('/revisions')
      const rawPath = isDraft || isRevisions ? suffix.slice(0, suffix.lastIndexOf('/')) : suffix
      const documentPath = normalizePath(rawPath)
      const workspace = url.searchParams.get('workspace') || 'default'
      if (!documentPath) return error('Document path is required')
      if (request.method === 'GET' && isRevisions) {
        await ensureDocument(env.DB, workspace, documentPath)
        const revisions = await env.DB.prepare('SELECT revision, content, created_at as updatedAt FROM revisions WHERE document_id=? ORDER BY revision DESC').bind(idFor(workspace, documentPath)).all<JsonRecord>()
        return json({ revisions: revisions.results ?? [] })
      }
      if (request.method === 'GET') return json(await readDocument(env.DB, workspace, documentPath))
      if (request.method === 'PUT' || (request.method === 'POST' && isDraft)) {
        let input: { workspace?: string; content?: string; baseRevision?: number; message?: string } | undefined
        let selectedWorkspace = workspace
        try {
          input = await body<{ workspace?: string; content?: string; baseRevision?: number; message?: string }>(request)
          selectedWorkspace = input.workspace || workspace
          if (typeof input.content !== 'string' || typeof input.baseRevision !== 'number') return error('content and numeric baseRevision are required')
          const result = await writeDocument(env.DB, selectedWorkspace, documentPath, input.content, input.baseRevision, isDraft ? 'draft' : 'published', authenticated.id, input.message)
          return result instanceof Response ? result : json(result)
        } catch (cause) {
          if (isRevisionConstraintError(cause)) return revisionConflict(env.DB, selectedWorkspace, documentPath, input?.content ?? '', input?.baseRevision ?? 0)
          return error(cause instanceof Error ? cause.message : 'Invalid request')
        }
      }
    }
    return error('Not found', 404)
  }
}
