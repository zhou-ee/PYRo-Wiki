let cachedMembers: Record<string, import('./preview/parser').Member> = {}

import * as vscode from 'vscode'
import { PyroCompletionProvider } from './completion'
import { loadMembers } from './preview/data'
import { PreviewController } from './preview/controller'
import { configuredWikiRoot, selectWikiRoot } from './workspace'
import { approveAndPublishRequest, pullCurrent, pushCurrent, rejectPublishRequest, retryPublishRequest, retryQueued, saveDraftCurrent, submitPublishRequestCurrent, viewCurrentRevisions, viewPublishRequests } from './sync/commands'
import { CollaborationClient } from './collaboration/client'
import { CollaborationProvider } from './collaboration/workspace'
import { extendMarkdownIt as extendNativeMarkdownIt } from './preview/native'
import { createRepositoryStatusItem, pullRepository, showRepositoryStatus } from './git'
import { WikiDocumentsProvider, searchMarkdownDocuments } from './markdownWorkspace'
import { AuthManager } from './auth/session'
import { CloudDocumentsProvider } from './cloudWorkspace'
import { pendingSyncCount } from './sync/queue'
import { initializeWikiWorkspace, pullSharedWiki } from './initialize'

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const authOutput = vscode.window.createOutputChannel('PYRo Wiki Auth')
  const auth = new AuthManager(context, authOutput)
  await auth.initialize()
  const preview = new PreviewController(context)
  const collaboration = new CollaborationClient(auth)
  const collaborationProvider = new CollaborationProvider(collaboration)
  const cloudDocuments = new CloudDocumentsProvider(context, auth)
  context.subscriptions.push(authOutput, auth, preview, collaboration, collaborationProvider, cloudDocuments)

  createRepositoryStatusItem(context)
  const authStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  authStatus.command = 'pyroWiki.signIn'
  const updateAuthStatus = () => {
    authStatus.text = auth.currentUser ? `$(account) ${auth.currentUser.name}` : '$(sign-in) PYRo Login'
    authStatus.tooltip = auth.currentUser ? `Signed in to PYRo Wiki as ${auth.currentUser.name}` : 'Sign in to PYRo Wiki with Feishu'
    authStatus.command = auth.currentUser ? 'pyroWiki.signOut' : 'pyroWiki.signIn'
    authStatus.show()
  }
  updateAuthStatus()

  const syncStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90)
  const updateSyncStatus = async (): Promise<void> => {
    const count = await pendingSyncCount(context)
    if (!auth.signedIn) {
      syncStatus.text = '$(cloud-offline) Cloud sync'
      syncStatus.tooltip = 'Sign in with Feishu to enable cloud sync'
      syncStatus.command = 'pyroWiki.signIn'
    } else if (count > 0) {
      syncStatus.text = `$(sync) ${count} pending`
      syncStatus.tooltip = `${count} document${count === 1 ? '' : 's'} waiting to sync. Click to retry.`
      syncStatus.command = 'pyroWiki.retrySyncQueue'
    } else {
      syncStatus.text = '$(cloud) Synced'
      syncStatus.tooltip = 'No pending cloud sync operations'
      syncStatus.command = 'pyroWiki.retrySyncQueue'
    }
    syncStatus.show()
  }
  const retrySyncQueue = async (silent = false): Promise<void> => {
    await retryQueued(context, auth, silent)
    await updateSyncStatus()
    void cloudDocuments.load()
  }
  const runPush = async (): Promise<void> => { await pushCurrent(context, auth); await updateSyncStatus(); void cloudDocuments.load() }
  const runPull = async (): Promise<void> => { await pullCurrent(context, auth); await updateSyncStatus(); void cloudDocuments.load() }
  const runDraft = async (): Promise<void> => { await saveDraftCurrent(context, auth); await updateSyncStatus(); void cloudDocuments.load() }
  const handleAuthChange = (): void => {
    updateAuthStatus()
    void updateSyncStatus()
    if (auth.signedIn) void retrySyncQueue(true)
    void cloudDocuments.load()
  }
  void updateSyncStatus()
  const syncStatusTimer = setInterval(() => { void updateSyncStatus() }, 5_000)
  context.subscriptions.push(syncStatus, { dispose: () => clearInterval(syncStatusTimer) }, auth.onDidChange(handleAuthChange))

  const markdownDocuments = new WikiDocumentsProvider()
  const markdownTreeView = vscode.window.createTreeView('pyroWiki.documents', { treeDataProvider: markdownDocuments, showCollapseAll: true })
  const cloudTreeView = vscode.window.createTreeView('pyroWiki.cloudDocuments', { treeDataProvider: cloudDocuments, showCollapseAll: false })
  const collaborationTreeView = vscode.window.createTreeView('pyroWiki.collaboration', { treeDataProvider: collaborationProvider, showCollapseAll: false })
  context.subscriptions.push(markdownDocuments, markdownTreeView, cloudTreeView, collaborationTreeView)

  const members = async (): Promise<Record<string, import('./preview/parser').Member>> => {
    const document = vscode.window.activeTextEditor?.document
    cachedMembers = document ? await loadMembers(configuredWikiRoot(document), context) : context.globalState.get('pyroWiki.membersCache', {})
    return cachedMembers
  }
  const getMembers = () => cachedMembers
  const provider = new PyroCompletionProvider(getMembers)

  context.subscriptions.push(
    vscode.commands.registerCommand('pyroWiki.initializeWorkspace', initializeWikiWorkspace),
    vscode.commands.registerCommand('pyroWiki.pullSharedWiki', () => pullSharedWiki(false)),
    vscode.commands.registerCommand('pyroWiki.selectWikiRoot', selectWikiRoot),
    vscode.commands.registerCommand('pyroWiki.openPreview', () => preview.open()),
    vscode.commands.registerCommand('pyroWiki.openSourceAndPreview', () => preview.open()),
    vscode.commands.registerCommand('pyroWiki.refreshPreview', () => preview.refresh()),
    vscode.commands.registerCommand('pyroWiki.pullRepository', pullRepository),
    vscode.commands.registerCommand('pyroWiki.repositoryStatus', showRepositoryStatus),
    vscode.commands.registerCommand('pyroWiki.openMarkdownWorkspace', () => vscode.commands.executeCommand('workbench.view.extension.pyroWiki')),
    vscode.commands.registerCommand('pyroWiki.searchMarkdownDocuments', searchMarkdownDocuments),
    vscode.commands.registerCommand('pyroWiki.refreshDocuments', () => markdownDocuments.refresh()),
    vscode.commands.registerCommand('pyroWiki.signIn', () => auth.signIn()),
    vscode.commands.registerCommand('pyroWiki.signOut', () => auth.signOut()),
    vscode.commands.registerCommand('pyroWiki.completeFeishuLogin', async () => {
      const handoff = await vscode.window.showInputBox({ prompt: 'Paste the Feishu fallback handoff code', password: true, ignoreFocusOut: true })
      if (handoff) await auth.completeHandoff(handoff)
    }),
    vscode.commands.registerCommand('pyroWiki.refreshCloudDocuments', () => cloudDocuments.load()),
    vscode.commands.registerCommand('pyroWiki.searchCloudDocuments', () => cloudDocuments.search()),
    vscode.commands.registerCommand('pyroWiki.openCloudDocument', (document) => cloudDocuments.openDocument(document)),
    vscode.commands.registerCommand('pyroWiki.viewCloudRevisions', (document) => cloudDocuments.showRevisions(document)),
    vscode.commands.registerCommand('pyroWiki.compareCloudDocument', (document) => cloudDocuments.compareWithLocal(document)),
    vscode.commands.registerCommand('pyroWiki.pullCloudDocument', (document) => cloudDocuments.pullDocument(document)),
    vscode.commands.registerCommand('pyroWiki.pushCloudDocument', (document) => cloudDocuments.pushDocument(document)),
    vscode.commands.registerCommand('pyroWiki.pullDocument', runPull),
    vscode.commands.registerCommand('pyroWiki.pushDocument', runPush),
    vscode.commands.registerCommand('pyroWiki.retrySyncQueue', () => retrySyncQueue(false)),
    vscode.commands.registerCommand('pyroWiki.saveDraft', runDraft),
    vscode.commands.registerCommand('pyroWiki.viewRevisions', () => viewCurrentRevisions(auth)),
    vscode.commands.registerCommand('pyroWiki.submitPublishRequest', () => submitPublishRequestCurrent(context, auth)),
    vscode.commands.registerCommand('pyroWiki.viewPublishRequests', () => viewPublishRequests(auth)),
    vscode.commands.registerCommand('pyroWiki.approveAndPublish', () => approveAndPublishRequest(auth)),
    vscode.commands.registerCommand('pyroWiki.rejectPublishRequest', () => rejectPublishRequest(auth)),
    vscode.commands.registerCommand('pyroWiki.retryPublishRequest', () => retryPublishRequest(auth)),
    vscode.commands.registerCommand('pyroWiki.resolveConflict', () => pushCurrent(context, auth)),
    vscode.commands.registerCommand('pyroWiki.joinCollaboration', () => collaboration.join()),
    vscode.commands.registerCommand('pyroWiki.leaveCollaboration', () => collaboration.leave()),
    vscode.languages.registerCompletionItemProvider({ language: 'markdown' }, provider, '/'),
    vscode.workspace.onDidOpenTextDocument(async () => { await members(); void cloudDocuments.load() }),
    vscode.workspace.onDidSaveTextDocument(() => { void cloudDocuments.load(); void retrySyncQueue(true); void updateSyncStatus() }),
    vscode.window.onDidChangeWindowState((state) => { if (state.focused) void retrySyncQueue(true) }),
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      if (editor?.document.languageId === 'markdown') {
        await members()
        void cloudDocuments.load()
      }
    })
  )
  const activeDocument = vscode.window.activeTextEditor?.document
  if (activeDocument?.languageId === 'markdown') {
    void preview.warmup(activeDocument)
    await members()
  }
}

export function deactivate(): void {}

export function extendMarkdownIt(md: any): any {
  return extendNativeMarkdownIt(md, () => cachedMembers)
}
