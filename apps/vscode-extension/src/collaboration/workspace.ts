import * as vscode from 'vscode'
import type { CollaborationClient, CollaborationSnapshot } from './client'

export type CollaborationNode = { kind: 'status'; label: string; detail?: string }

export class CollaborationProvider implements vscode.TreeDataProvider<CollaborationNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<CollaborationNode | undefined | null | void>()
  private readonly disposables: vscode.Disposable[]

  constructor(private readonly client: CollaborationClient) {
    this.disposables = [this.emitter, client.onDidChange(() => this.refresh())]
  }

  readonly onDidChangeTreeData = this.emitter.event

  getTreeItem(node: CollaborationNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None)
    item.description = node.detail
    item.iconPath = new vscode.ThemeIcon(node.label.includes('Connected') ? 'radio-tower' : 'broadcast')
    return item
  }

  getChildren(): CollaborationNode[] {
    const state = this.client.state
    const nodes: CollaborationNode[] = [{ kind: 'status', label: this.statusLabel(state.status), detail: state.documentPath ?? 'No collaboration document' }]
    if (state.users.length) nodes.push({ kind: 'status', label: `Online users: ${state.users.length}`, detail: state.users.join(', ') })
    if (state.error) nodes.push({ kind: 'status', label: 'Error', detail: state.error })
    return nodes
  }

  refresh(): void { this.emitter.fire() }

  private statusLabel(status: CollaborationSnapshot['status']): string {
    return status.charAt(0).toUpperCase() + status.slice(1)
  }

  dispose(): void { for (const disposable of this.disposables) disposable.dispose() }
}
