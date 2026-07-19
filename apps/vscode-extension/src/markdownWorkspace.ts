import * as vscode from 'vscode'
import * as path from 'node:path'

export interface WikiTreeNode {
  kind: 'root' | 'directory' | 'file'
  name: string
  uri?: vscode.Uri
  relativePath: string
  children?: WikiTreeNode[]
}

const EXCLUDE = '**/{node_modules,.git,.vitepress,public,.github,.vscode,apps,infra,migrations,workers,dist,build,.wrangler}/**'

function wikiRootUri(): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (!folder) return undefined
  const configured = vscode.workspace.getConfiguration('pyroWiki', folder.uri).get<string>('wikiRoot', '').trim()
  if (!configured) return folder.uri
  return path.isAbsolute(configured) ? vscode.Uri.file(path.normalize(configured)) : vscode.Uri.joinPath(folder.uri, configured)
}

export class WikiDocumentsProvider implements vscode.TreeDataProvider<WikiTreeNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<WikiTreeNode | undefined | null | void>()
  readonly onDidChangeTreeData = this.changeEmitter.event
  private readonly disposables: vscode.Disposable[] = []
  private root: WikiTreeNode = { kind: 'root', name: 'Markdown Documents', relativePath: '' }

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.md')
    this.disposables.push(
      watcher,
      watcher.onDidCreate(() => this.refresh()),
      watcher.onDidDelete(() => this.refresh()),
      watcher.onDidChange(() => this.refresh())
    )
  }

  refresh(): void {
    this.changeEmitter.fire()
  }

  getTreeItem(node: WikiTreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.name, node.kind === 'file' ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed)
    if (node.kind === 'file' && node.uri) {
      item.resourceUri = node.uri
      item.command = { command: 'vscode.open', title: 'Open Markdown document', arguments: [node.uri, { preview: false, viewColumn: vscode.ViewColumn.One }] }
      item.contextValue = 'pyroWikiMarkdownFile'
      item.iconPath = new vscode.ThemeIcon('markdown')
      item.tooltip = node.relativePath
    } else if (node.kind === 'directory') {
      item.contextValue = 'pyroWikiMarkdownDirectory'
      item.iconPath = new vscode.ThemeIcon('folder')
    } else {
      item.iconPath = new vscode.ThemeIcon('book')
    }
    return item
  }

  async getChildren(node?: WikiTreeNode): Promise<WikiTreeNode[]> {
    if (!node) {
      this.root.children = await this.buildTree()
      return this.root.children
    }
    return node.children ?? []
  }

  private async buildTree(): Promise<WikiTreeNode[]> {
    const rootUri = wikiRootUri()
    if (!rootUri) return []
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(rootUri, '**/*.md'), EXCLUDE)
    const root: WikiTreeNode = { kind: 'root', name: 'Markdown Documents', relativePath: '', children: [] }
    for (const uri of files.sort((a, b) => a.fsPath.localeCompare(b.fsPath))) {
      const relative = path.relative(rootUri.fsPath, uri.fsPath).replaceAll('\\', '/')
      if (!relative || relative.startsWith('..')) continue
      const parts = relative.split('/')
      let children = root.children!
      let currentPath = ''
      for (let index = 0; index < parts.length; index += 1) {
        const name = parts[index]
        const isFile = index === parts.length - 1
        currentPath = currentPath ? `${currentPath}/${name}` : name
        let child = children.find((candidate) => candidate.name === name)
        if (!child) {
          child = isFile
            ? { kind: 'file', name, relativePath: currentPath, uri }
            : { kind: 'directory', name, relativePath: currentPath, children: [] }
          children.push(child)
        }
        if (!isFile) children = child.children!
      }
    }
    const sort = (nodes: WikiTreeNode[]) => {
      nodes.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name))
      for (const node of nodes) if (node.children) sort(node.children)
    }
    sort(root.children!)
    return root.children!
  }

  dispose(): void {
    this.changeEmitter.dispose()
    for (const disposable of this.disposables) disposable.dispose()
  }
}

export async function searchMarkdownDocuments(): Promise<void> {
  const rootUri = wikiRootUri()
  if (!rootUri) return void vscode.window.showWarningMessage('Open a workspace before searching Wiki documents.')
  const query = await vscode.window.showInputBox({ prompt: 'Search PYRo Wiki Markdown documents', placeHolder: 'title, keyword, or path' })
  if (!query) return
  const files = await vscode.workspace.findFiles(new vscode.RelativePattern(rootUri, '**/*.md'), EXCLUDE)
  const matches: Array<{ uri: vscode.Uri; line: number; text: string }> = []
  for (const uri of files) {
    const document = await vscode.workspace.openTextDocument(uri)
    for (let line = 0; line < document.lineCount; line += 1) {
      const text = document.lineAt(line).text
      if (text.toLocaleLowerCase().includes(query.toLocaleLowerCase())) matches.push({ uri, line, text: text.trim() })
      if (matches.length >= 200) break
    }
    if (matches.length >= 200) break
  }
  const picked = await vscode.window.showQuickPick(matches.map((match) => ({
    label: `${path.relative(rootUri.fsPath, match.uri.fsPath).replaceAll('\\', '/')}:${match.line + 1}`,
    description: match.text,
    match
  })), { placeHolder: matches.length ? `${matches.length} Markdown matches` : 'No Markdown matches found' })
  if (picked) {
    const editor = await vscode.window.showTextDocument(picked.match.uri, { viewColumn: vscode.ViewColumn.One, preview: false })
    editor.revealRange(new vscode.Range(picked.match.line, 0, picked.match.line, 0), vscode.TextEditorRevealType.InCenter)
  }
}
