let cachedMembers: Record<string, import('./preview/parser').Member> = {}

import * as vscode from 'vscode'
import { PyroCompletionProvider } from './completion'
import { loadMembers } from './preview/data'
import { PreviewController } from './preview/controller'
import { configuredWikiRoot, selectWikiRoot } from './workspace'
import { pullCurrent, pushCurrent } from './sync/commands'
import { CollaborationClient } from './collaboration/client'
import { extendMarkdownIt as extendNativeMarkdownIt } from './preview/native'
import { createRepositoryStatusItem, pullRepository, showRepositoryStatus } from './git'
import { WikiDocumentsProvider, searchMarkdownDocuments } from './markdownWorkspace'

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const preview = new PreviewController(context)
  const collaboration = new CollaborationClient()
  context.subscriptions.push(preview, collaboration)
  createRepositoryStatusItem(context)
  const markdownDocuments = new WikiDocumentsProvider()
  const markdownTreeView = vscode.window.createTreeView('pyroWiki.documents', { treeDataProvider: markdownDocuments, showCollapseAll: true })
  context.subscriptions.push(markdownDocuments, markdownTreeView)
  // This activity-bar view is an independent Markdown document index. It does
  // not replace the current folder and does not modify Explorer's visibility.

  const members = async (): Promise<Record<string, import('./preview/parser').Member>> => {
    const document = vscode.window.activeTextEditor?.document
    cachedMembers = document ? await loadMembers(configuredWikiRoot(document), context) : context.globalState.get('pyroWiki.membersCache', {})
    return cachedMembers
  }
  const getMembers = () => cachedMembers
  const provider = new PyroCompletionProvider(getMembers)

  context.subscriptions.push(
    vscode.commands.registerCommand('pyroWiki.selectWikiRoot', selectWikiRoot),
    vscode.commands.registerCommand('pyroWiki.openPreview', () => preview.open()),
    vscode.commands.registerCommand('pyroWiki.openSourceAndPreview', () => preview.open()),
    vscode.commands.registerCommand('pyroWiki.refreshPreview', () => preview.refresh()),
    vscode.commands.registerCommand('pyroWiki.pullRepository', pullRepository),
    vscode.commands.registerCommand('pyroWiki.repositoryStatus', showRepositoryStatus),
    vscode.commands.registerCommand('pyroWiki.openMarkdownWorkspace', () => vscode.commands.executeCommand('workbench.view.extension.pyroWiki')),
    vscode.commands.registerCommand('pyroWiki.searchMarkdownDocuments', searchMarkdownDocuments),
    vscode.commands.registerCommand('pyroWiki.refreshDocuments', () => markdownDocuments.refresh()),
    vscode.commands.registerCommand('pyroWiki.pullDocument', () => pullCurrent(context)),
    vscode.commands.registerCommand('pyroWiki.pushDocument', () => pushCurrent(context)),
    vscode.commands.registerCommand('pyroWiki.resolveConflict', () => pullCurrent(context)),
    vscode.commands.registerCommand('pyroWiki.joinCollaboration', () => collaboration.join()),
    vscode.languages.registerCompletionItemProvider({ language: 'markdown' }, provider, '/'),
    vscode.workspace.onDidOpenTextDocument(async () => { await members() }),
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      if (editor?.document.languageId === 'markdown') await members()
    }),
  )
  const activeDocument = vscode.window.activeTextEditor?.document
  if (activeDocument?.languageId === 'markdown') {
    // Start VitePress in the background while activation finishes so the first
    // preview command can reuse the already-warm dev server.
    void preview.warmup(activeDocument)
    await members()
  }

}

export function deactivate(): void {}

export function extendMarkdownIt(md: any): any {
  return extendNativeMarkdownIt(md, () => cachedMembers)
}
