import * as vscode from 'vscode'
import * as path from 'node:path'
import { ApiClient, type RemoteDocument } from './sync/api'
import { AuthManager } from './auth/session'
import { workspaceRoot } from './workspace'

const DEFAULT_API_BASE_URL = 'https://pyro-wiki-api.luckyy.ccwu.cc'

export type CloudNode =
  | { kind: 'document'; document: RemoteDocument }
  | { kind: 'signIn' }
  | { kind: 'empty' }

export function workspaceIdForRoot(root: string): string {
  return path.basename(root).replace(/[^A-Za-z0-9_-]/g, '-').toLowerCase() || 'default'
}

export class CloudDocumentsProvider implements vscode.TreeDataProvider<CloudNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<CloudNode | undefined | null | void>()
  private readonly disposables: vscode.Disposable[] = [this.emitter]
  private documents: RemoteDocument[] = []
  private loading = false

  readonly onDidChangeTreeData = this.emitter.event

  constructor(private readonly auth: AuthManager) {
    this.disposables.push(auth.onDidChange(() => { this.documents = []; this.refresh() }))
  }

  getTreeItem(node: CloudNode): vscode.TreeItem {
    if (node.kind === 'signIn') {
      const item = new vscode.TreeItem('Sign in with Feishu', vscode.TreeItemCollapsibleState.None)
      item.command = { command: 'pyroWiki.signIn', title: 'Sign in with Feishu' }
      item.iconPath = new vscode.ThemeIcon('account')
      return item
    }
    if (node.kind === 'empty') {
      const item = new vscode.TreeItem('No remote documents', vscode.TreeItemCollapsibleState.None)
      item.iconPath = new vscode.ThemeIcon('info')
      return item
    }
    const item = new vscode.TreeItem(node.document.path, vscode.TreeItemCollapsibleState.None)
    item.description = `r${node.document.revision}`
    item.tooltip = `${node.document.title}\nUpdated: ${node.document.updatedAt}`
    item.contextValue = 'pyroWiki.cloudDocument'
    item.iconPath = new vscode.ThemeIcon('cloud')
    item.command = { command: 'pyroWiki.openCloudDocument', title: 'Open Cloud Document', arguments: [node.document] }
    return item
  }

  async getChildren(): Promise<CloudNode[]> {
    if (!this.auth.signedIn) return [{ kind: 'signIn' }]
    if (this.loading) return []
    if (!this.documents.length) await this.load()
    return this.documents.length ? this.documents.map((document) => ({ kind: 'document', document })) : [{ kind: 'empty' }]
  }

  async load(): Promise<void> {
    if (this.loading || !this.auth.signedIn) return
    const root = workspaceRoot(vscode.window.activeTextEditor?.document ?? vscode.window.visibleTextEditors[0]?.document) ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!root) { this.documents = []; this.refresh(); return }
    this.loading = true
    try {
      const client = this.client(root)
      this.documents = (await client.listDocuments()).documents
    } catch (error) {
      this.documents = []
      void vscode.window.showErrorMessage(`Could not load PYRo Wiki cloud documents: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.loading = false
      this.refresh()
    }
  }

  async openDocument(document: RemoteDocument): Promise<void> {
    const root = workspaceRoot(vscode.window.activeTextEditor?.document ?? vscode.window.visibleTextEditors[0]?.document) ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!root) return void vscode.window.showWarningMessage('Open a workspace before opening a cloud document.')
    try {
      const remote = await this.client(root).getDocument(document.path)
      const local = await vscode.workspace.openTextDocument({ content: remote.content, language: 'markdown' })
      await vscode.window.showTextDocument(local, { preview: false })
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not open cloud document: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  refresh(): void { this.emitter.fire() }

  private client(root: string): ApiClient {
    const baseUrl = vscode.workspace.getConfiguration('pyroWiki').get<string>('apiBaseUrl', DEFAULT_API_BASE_URL)
    return new ApiClient(baseUrl, workspaceIdForRoot(root), this.auth)
  }

  dispose(): void { for (const disposable of this.disposables) disposable.dispose() }
}
