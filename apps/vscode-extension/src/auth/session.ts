import * as vscode from 'vscode'

export interface AuthUser {
  id: string
  openId: string
  unionId?: string
  tenantKey?: string
  name: string
  avatar?: string
}

export interface AuthProvider {
  getAccessToken(): Promise<string | undefined>
  refresh(): Promise<string | undefined>
}

const REFRESH_TOKEN_KEY = 'pyroWiki.auth.refreshToken'
const USER_KEY = 'pyroWiki.auth.user'
const DEFAULT_API_BASE_URL = 'https://pyro-wiki-api.luckyy.ccwu.cc'

export class AuthManager implements vscode.Disposable, AuthProvider {
  private readonly changeEmitter = new vscode.EventEmitter<AuthUser | undefined>()
  private readonly disposables: vscode.Disposable[] = [this.changeEmitter]
  private accessToken: string | undefined
  private accessExpiresAt = 0
  private refreshToken: string | undefined
  private refreshInFlight: Promise<string | undefined> | undefined
  private user: AuthUser | undefined

  readonly onDidChange = this.changeEmitter.event

  constructor(private readonly context: vscode.ExtensionContext) {
    this.user = context.globalState.get<AuthUser>(USER_KEY)
    this.disposables.push(vscode.window.registerUriHandler({ handleUri: (uri) => { void this.handleUri(uri) } }))
  }

  get currentUser(): AuthUser | undefined { return this.user }
  get signedIn(): boolean { return Boolean(this.refreshToken || this.user) }

  private apiBaseUrl(): string {
    return vscode.workspace.getConfiguration('pyroWiki').get<string>('apiBaseUrl', DEFAULT_API_BASE_URL).replace(/\/$/, '')
  }

  async initialize(): Promise<void> {
    this.refreshToken = await this.context.secrets.get(REFRESH_TOKEN_KEY)
    if (this.refreshToken && !this.user) {
      try { await this.refresh() } catch { await this.clearSession(false) } }
  }

  async signIn(): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(`${this.apiBaseUrl()}/auth/feishu/start`))
  }

  async handleUri(uri: vscode.Uri): Promise<void> {
    if (uri.path !== '/auth/callback' && !uri.path.endsWith('/auth/callback')) return
    const handoff = new URLSearchParams(uri.query).get('handoff')
    if (!handoff) { void vscode.window.showErrorMessage('PYRo Wiki Feishu login returned no handoff code.'); return }
    try {
      const response = await fetch(`${this.apiBaseUrl()}/auth/session/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handoff })
      })
      const body = await response.json() as { accessToken?: string; refreshToken?: string; expiresIn?: number; user?: AuthUser; error?: string }
      if (!response.ok || !body.accessToken || !body.refreshToken || !body.user) throw new Error(body.error ?? `HTTP ${response.status}`)
      await this.applySession(body.accessToken, body.refreshToken, body.expiresIn ?? 900, body.user)
      void vscode.window.showInformationMessage(`Signed in to PYRo Wiki as ${body.user.name}.`)
    } catch (error) {
      void vscode.window.showErrorMessage(`PYRo Wiki Feishu login failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async getAccessToken(): Promise<string | undefined> {
    if (this.accessToken && Date.now() < this.accessExpiresAt - 30_000) return this.accessToken
    return this.refresh()
  }

  async refresh(): Promise<string | undefined> {
    if (this.refreshInFlight) return this.refreshInFlight
    this.refreshInFlight = this.refreshInternal().finally(() => { this.refreshInFlight = undefined })
    return this.refreshInFlight
  }

  private async refreshInternal(): Promise<string | undefined> {
    this.refreshToken ??= await this.context.secrets.get(REFRESH_TOKEN_KEY)
    if (!this.refreshToken) return undefined
    const response = await fetch(`${this.apiBaseUrl()}/auth/session/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: this.refreshToken })
    })
    const body = await response.json() as { accessToken?: string; refreshToken?: string; expiresIn?: number; user?: AuthUser; error?: string }
    if (!response.ok || !body.accessToken || !body.refreshToken || !body.user) {
      await this.clearSession(false)
      throw new Error(body.error ?? `HTTP ${response.status}`)
    }
    await this.applySession(body.accessToken, body.refreshToken, body.expiresIn ?? 900, body.user)
    return this.accessToken
  }

  private async applySession(accessToken: string, refreshToken: string, expiresIn: number, user: AuthUser): Promise<void> {
    this.accessToken = accessToken
    this.accessExpiresAt = Date.now() + expiresIn * 1000
    this.refreshToken = refreshToken
    this.user = user
    await this.context.secrets.store(REFRESH_TOKEN_KEY, refreshToken)
    await this.context.globalState.update(USER_KEY, user)
    this.changeEmitter.fire(user)
  }

  async signOut(): Promise<void> {
    try {
      const token = await this.getAccessToken()
      if (token) await fetch(`${this.apiBaseUrl()}/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
    } catch { /* local sign-out still succeeds */ }
    await this.clearSession(true)
    void vscode.window.showInformationMessage('Signed out of PYRo Wiki.')
  }

  private async clearSession(notify: boolean): Promise<void> {
    this.accessToken = undefined
    this.accessExpiresAt = 0
    this.refreshToken = undefined
    this.user = undefined
    await this.context.secrets.delete(REFRESH_TOKEN_KEY)
    await this.context.globalState.update(USER_KEY, undefined)
    if (notify) this.changeEmitter.fire(undefined)
  }

  dispose(): void { for (const disposable of this.disposables) disposable.dispose() }
}
