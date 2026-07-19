export interface RemoteDocument {
  path: string
  title: string
  content: string
  revision: number
  updatedAt: string
}

export interface ConflictResponse {
  local: { content: string; revision: number }
  remote: RemoteDocument
  common: { content: string; revision: number } | null
}

export class ApiClient {
  constructor(private readonly baseUrl: string, private readonly workspaceId: string) {}
  private url(path: string): string { return `${this.baseUrl.replace(/\/$/, '')}${path}` }
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(this.url(path), { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } })
    const body = await response.json().catch(() => ({})) as T & { error?: string }
    if (!response.ok) throw Object.assign(new Error(body.error ?? `HTTP ${response.status}`), { status: response.status, body })
    return body
  }
  health(): Promise<{ ok: boolean }> { return this.request('/health') }
  listDocuments(): Promise<{ documents: RemoteDocument[] }> { return this.request(`/documents?workspace=${encodeURIComponent(this.workspaceId)}`) }
  getDocument(path: string): Promise<RemoteDocument> { return this.request(`/documents/${encodeURIComponent(path)}?workspace=${encodeURIComponent(this.workspaceId)}`) }
  putDocument(path: string, content: string, baseRevision: number, message?: string): Promise<RemoteDocument> {
    return this.request(`/documents/${encodeURIComponent(path)}`, { method: 'PUT', body: JSON.stringify({ workspace: this.workspaceId, content, baseRevision, message }) })
  }
  saveDraft(path: string, content: string, baseRevision: number): Promise<RemoteDocument> {
    return this.request(`/documents/${encodeURIComponent(path)}/drafts`, { method: 'POST', body: JSON.stringify({ workspace: this.workspaceId, content, baseRevision }) })
  }
  revisions(path: string): Promise<{ revisions: RemoteDocument[] }> { return this.request(`/documents/${encodeURIComponent(path)}/revisions?workspace=${encodeURIComponent(this.workspaceId)}`) }
  authors(): Promise<{ authors: unknown[] }> { return this.request('/authors') }
}
