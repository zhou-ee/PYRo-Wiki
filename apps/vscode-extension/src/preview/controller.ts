import * as vscode from 'vscode'
import { previewDocument } from './parser'
import { loadMembers } from './data'
import { isWikiDocument, workspaceRoot } from '../workspace'

export class PreviewController implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined
  private readonly disposables: vscode.Disposable[] = []
  private currentDocument: vscode.TextDocument | undefined
  private sourceEditor: vscode.TextEditor | undefined
  private members: Record<string, import('./parser').Member> = {}
  private movingSource = false
  private suppressSourceScroll = false

  constructor(private readonly context: vscode.ExtensionContext) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.panel && this.currentDocument?.uri.toString() === event.document.uri.toString()) this.render(event.document)
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (this.panel && editor?.document) void this.followEditor(editor)
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
        if (this.panel && this.currentDocument && event.textEditor.document.uri.toString() === this.currentDocument.uri.toString()) this.sendSourceScroll(event.textEditor)
      }),
      vscode.window.onDidChangeActiveColorTheme(() => {
        if (this.panel && this.currentDocument) this.render(this.currentDocument)
      })
    )
  }

  private get lockLayout(): boolean {
    return vscode.workspace.getConfiguration('pyroWiki').get<boolean>('lockPreviewLayout', true)
  }

  private get followActiveMarkdown(): boolean {
    return vscode.workspace.getConfiguration('pyroWiki').get<boolean>('followActiveMarkdown', true)
  }

  private async showSourceLeft(document: vscode.TextDocument, preserveFocus: boolean): Promise<vscode.TextEditor> {
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus,
      preview: false
    })
    await this.closeDuplicateSourceTabs(document.uri, editor)
    return editor
  }

  private async closeDuplicateSourceTabs(uri: vscode.Uri, keep: vscode.TextEditor): Promise<void> {
    const duplicates: vscode.Tab[] = []
    for (const group of vscode.window.tabGroups.all) {
      if (group.viewColumn === vscode.ViewColumn.One) continue
      for (const tab of group.tabs) {
        const input = tab.input
        const isSource = input instanceof vscode.TabInputText && input.uri.toString() === uri.toString()
        const isNativeMarkdownPreview = input instanceof vscode.TabInputWebview && /markdown\.preview|vscode\.markdown\.preview/i.test(input.viewType)
        if (isSource || isNativeMarkdownPreview) duplicates.push(tab)
      }
    }
    if (duplicates.length) await vscode.window.tabGroups.close(duplicates, true)
    this.sourceEditor = keep
  }

  private async setDocument(document: vscode.TextDocument, editor?: vscode.TextEditor): Promise<void> {
    this.currentDocument = document
    this.sourceEditor = editor ?? this.sourceEditor
    this.members = await loadMembers(workspaceRoot(document), this.context)
    this.render(document)
    if (this.sourceEditor) this.sendSourceScroll(this.sourceEditor)
  }

  private async followEditor(editor: vscode.TextEditor): Promise<void> {
    if (!this.panel || !this.followActiveMarkdown || !isWikiDocument(editor.document)) {
      if (this.panel && editor?.document) this.render(editor.document)
      return
    }
    let sourceEditor = editor
    if (this.lockLayout && editor.viewColumn !== vscode.ViewColumn.One && !this.movingSource) {
      this.movingSource = true
      try {
        sourceEditor = await this.showSourceLeft(editor.document, true)
      } finally {
        this.movingSource = false
      }
    }
    await this.setDocument(sourceEditor.document, sourceEditor)
  }

  private sendSourceScroll(editor: vscode.TextEditor): void {
    if (!this.panel || this.suppressSourceScroll || !this.currentDocument || editor.document.uri.toString() !== this.currentDocument.uri.toString()) return
    const visible = editor.visibleRanges[0]
    const lineCount = Math.max(1, editor.document.lineCount)
    const startLine = Math.max(0, Math.min(lineCount - 1, visible?.start.line ?? 0))
    const endLineExclusive = Math.min(lineCount, Math.max(startLine + 1, (visible?.end.line ?? startLine) + 1))
    const visibleLines = Math.max(1, endLineExclusive - startLine)
    const maxStart = Math.max(0, lineCount - visibleLines)
    const ratio = maxStart === 0 ? 0 : Math.max(0, Math.min(1, startLine / maxStart))
    void this.panel.webview.postMessage({ type: 'sourceScroll', ratio })
  }

  private async handleWebviewMessage(message: { type?: string; ratio?: number }): Promise<void> {
    if (message.type === 'previewReady') {
      if (this.sourceEditor) this.sendSourceScroll(this.sourceEditor)
      return
    }
    if (message.type !== 'previewScroll' || typeof message.ratio !== 'number' || !this.sourceEditor || !this.currentDocument) return
    const editor = this.sourceEditor
    const visible = editor.visibleRanges[0]
    const visibleLines = Math.max(1, visible ? visible.end.line - visible.start.line + 1 : 1)
    const maxStart = Math.max(0, editor.document.lineCount - visibleLines)
    const targetLine = Math.round(Math.max(0, Math.min(1, message.ratio)) * maxStart)
    this.suppressSourceScroll = true
    try {
      editor.revealRange(new vscode.Range(targetLine, 0, targetLine, 0), vscode.TextEditorRevealType.AtTop)
    } finally {
      setTimeout(() => { this.suppressSourceScroll = false }, 400)
    }
  }

  async open(document = vscode.window.activeTextEditor?.document): Promise<void> {
    if (!document || !isWikiDocument(document)) {
      void vscode.window.showInformationMessage('Open a Markdown file inside the configured PYRo Wiki root first.')
      return
    }
    const sourceEditor = await this.showSourceLeft(document, false)
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('pyroWikiPreview', 'PYRo Wiki Preview', vscode.ViewColumn.Two, { enableScripts: true, retainContextWhenHidden: true })
      this.disposables.push(this.panel.webview.onDidReceiveMessage((message) => this.handleWebviewMessage(message)))
      this.panel.onDidDispose(() => {
        this.panel = undefined
        this.currentDocument = undefined
        this.sourceEditor = undefined
      }, null, this.disposables)
    }
    await this.setDocument(sourceEditor.document, sourceEditor)
    this.panel.reveal(vscode.ViewColumn.Two, true)
  }

  async refresh(): Promise<void> {
    if (this.currentDocument) await this.setDocument(this.currentDocument)
  }

  private render(document: vscode.TextDocument): void {
    if (!this.panel || !isWikiDocument(document)) {
      if (this.panel) this.panel.webview.html = '<!doctype html><html><body><p>PYRo Wiki preview is disabled for this file.</p></body></html>'
      return
    }
    this.currentDocument = document
    const theme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark || vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast ? 'dark' : 'light'
    this.panel.title = `PYRo Wiki: ${document.fileName.split(/[\\/]/).pop() ?? 'Preview'}`
    this.panel.webview.html = previewDocument(document.getText(), { members: this.members, theme, documentUri: document.uri.toString() })
  }

  dispose(): void {
    this.panel?.dispose()
    for (const disposable of this.disposables) disposable.dispose()
  }
}
