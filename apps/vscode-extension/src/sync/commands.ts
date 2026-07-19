import * as vscode from 'vscode'
import * as path from 'node:path'
import { ApiClient, ApiError, type ConflictResponse } from './api'
import { enqueueSync, pendingSyncItems, removeSync } from './queue'
import type { AuthManager } from '../auth/session'
import { isWikiDocument, workspaceRoot } from '../workspace'

const DEFAULT_API_BASE_URL = 'https://pyro-wiki-api.luckyy.ccwu.cc'

export function makeClient(document: vscode.TextDocument, auth?: AuthManager): ApiClient | undefined {
  const root = workspaceRoot(document)
  if (!root) return undefined
  const baseUrl = vscode.workspace.getConfiguration('pyroWiki').get<string>('apiBaseUrl', DEFAULT_API_BASE_URL)
  const workspaceId = path.basename(root).replace(/[^A-Za-z0-9_-]/g, '-').toLowerCase() || 'default'
  return new ApiClient(baseUrl, workspaceId, auth)
}

export function documentPath(document: vscode.TextDocument): string {
  return path.relative(workspaceRoot(document)!, document.uri.fsPath).replaceAll('\\', '/')
}

function revisionKey(document: vscode.TextDocument): string { return `pyroWiki.revision.${document.uri.toString()}` }
function isTransient(error: unknown): boolean {
  const status = error instanceof ApiError ? error.status : (error as { status?: number }).status
  return status === undefined || status === 408 || status === 429 || (status !== undefined && status >= 500)
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

async function replaceDocument(document: vscode.TextDocument, content: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit()
  const endLine = Math.max(0, document.lineCount - 1)
  edit.replace(document.uri, new vscode.Range(0, 0, endLine, document.lineAt(endLine).text.length), content)
  await vscode.workspace.applyEdit(edit)
}

async function resolveConflict(context: vscode.ExtensionContext, document: vscode.TextDocument, client: ApiClient, conflict: ConflictResponse): Promise<void> {
  const remote = conflict.remote
  const common = conflict.common
  const choice = await vscode.window.showQuickPick([
    { label: 'Keep local and push again', value: 'local', description: `Use remote revision ${remote.revision} as the new base.` },
    { label: 'Keep remote', value: 'remote', description: 'Replace the local file with the current cloud version.' },
    { label: 'Open three-way comparison', value: 'manual', description: 'Review common ancestor, local content and remote content.' },
    { label: 'Cancel', value: 'cancel' }
  ], { placeHolder: 'Resolve the cloud document conflict' })
  if (!choice || choice.value === 'cancel') return
  await context.workspaceState.update(revisionKey(document), remote.revision)
  if (choice.value === 'remote') {
    await replaceDocument(document, remote.content ?? '')
    await document.save()
    void vscode.window.showInformationMessage(`Kept cloud revision ${remote.revision}.`)
    return
  }
  if (choice.value === 'local') {
    try {
      const result = await client.putDocument(documentPath(document), document.getText(), remote.revision)
      await context.workspaceState.update(revisionKey(document), result.revision)
      void vscode.window.showInformationMessage(`Uploaded merged local revision ${result.revision}.`)
    } catch (error) {
      void vscode.window.showWarningMessage(`The document changed again; review the conflict once more. ${errorMessage(error)}`)
    }
    return
  }
  const localDoc = await vscode.workspace.openTextDocument({ content: conflict.local.content, language: 'markdown' })
  const remoteDoc = await vscode.workspace.openTextDocument({ content: remote.content ?? '', language: 'markdown' })
  if (common) {
    const commonDoc = await vscode.workspace.openTextDocument({ content: common.content, language: 'markdown' })
    await vscode.commands.executeCommand('vscode.diff', commonDoc.uri, localDoc.uri, `PYRo: common ? local (r${common.revision})`)
    await vscode.commands.executeCommand('vscode.diff', commonDoc.uri, remoteDoc.uri, `PYRo: common ? remote (r${remote.revision})`)
  } else {
    await vscode.commands.executeCommand('vscode.diff', localDoc.uri, remoteDoc.uri, `PYRo: local / remote (r${remote.revision})`)
  }
  void vscode.window.showInformationMessage(`Manual merge ready. The cloud base is now revision ${remote.revision}; edit the local file and push again.`)
}

export async function pushCurrent(context: vscode.ExtensionContext, auth: AuthManager, document = vscode.window.activeTextEditor?.document): Promise<void> {
  if (!document || !isWikiDocument(document)) return void vscode.window.showWarningMessage('Current document is outside the PYRo Wiki root.')
  const client = makeClient(document, auth)
  if (!client) return
  const baseRevision = context.workspaceState.get<number>(revisionKey(document), 0)
  try {
    const result = await client.putDocument(documentPath(document), document.getText(), baseRevision)
    await context.workspaceState.update(revisionKey(document), result.revision)
    void vscode.window.showInformationMessage(`Uploaded revision ${result.revision}.`)
  } catch (error) {
    if ((error as { status?: number }).status === 409) {
      const body = (error instanceof ApiError ? error.body : (error as { body?: unknown }).body) as Partial<ConflictResponse> | undefined
      if (body?.remote) await resolveConflict(context, document, client, body as ConflictResponse)
      else void vscode.window.showWarningMessage('Remote document changed. Pull the latest version before pushing again.')
    } else if ((error as { status?: number }).status === 401) {
      void vscode.window.showWarningMessage('Sign in with Feishu before pushing a document.')
    } else if (isTransient(error)) {
      await enqueueSync(context, { uri: document.uri.toString(), path: documentPath(document), workspaceId: path.basename(workspaceRoot(document)!).replace(/[^A-Za-z0-9_-]/g, '-').toLowerCase() || 'default', content: document.getText(), baseRevision })
      void vscode.window.showWarningMessage('Network unavailable. The document was added to the PYRo Wiki sync queue.')
    } else void vscode.window.showErrorMessage(`PYRo Wiki upload failed: ${errorMessage(error)}`)
  }
}

export async function retryQueued(context: vscode.ExtensionContext, auth: AuthManager, silent = false): Promise<void> {
  const queued = await pendingSyncItems(context)
  if (!queued.length) {
    if (!silent) void vscode.window.showInformationMessage('PYRo Wiki sync queue is empty.')
    return
  }
  let uploaded = 0
  for (const item of queued) {
    let document: vscode.TextDocument
    try { document = await vscode.workspace.openTextDocument(vscode.Uri.parse(item.uri)) }
    catch { await removeSync(context, item.id); continue }
    const client = makeClient(document, auth)
    if (!client) continue
    try {
      const result = await client.putDocument(item.path, item.content, item.baseRevision)
      await context.workspaceState.update(revisionKey(document), result.revision)
      await removeSync(context, item.id)
      uploaded += 1
    } catch (error) {
      if ((error as { status?: number }).status === 401) {
        if (!silent) void vscode.window.showWarningMessage('Sign in with Feishu before retrying the sync queue.')
        return
      }
      if ((error as { status?: number }).status === 409) {
        if (!silent) void vscode.window.showWarningMessage(`Queued document ${item.path} has a cloud conflict. Open it and resolve the conflict manually.`)
      }
      else if (!isTransient(error)) await removeSync(context, item.id)
      break
    }
  }
  if (uploaded && !silent) void vscode.window.showInformationMessage(`Uploaded ${uploaded} queued document${uploaded === 1 ? '' : 's'}.`)
}

export async function pullCurrent(context: vscode.ExtensionContext, auth: AuthManager, document = vscode.window.activeTextEditor?.document): Promise<void> {
  if (!document || !isWikiDocument(document)) return void vscode.window.showWarningMessage('Current document is outside the PYRo Wiki root.')
  const client = makeClient(document, auth)
  if (!client) return
  try {
    const remote = await client.getDocument(documentPath(document))
    await replaceDocument(document, remote.content ?? '')
    await document.save()
    await context.workspaceState.update(revisionKey(document), remote.revision)
    void vscode.window.showInformationMessage(`Pulled revision ${remote.revision}.`)
  } catch (error) {
    if ((error as { status?: number }).status === 401) void vscode.window.showWarningMessage('Sign in with Feishu before pulling a document.')
    else if (isTransient(error)) void vscode.window.showWarningMessage('PYRo Wiki is temporarily unreachable. Try Pull again when the network is available.')
    else void vscode.window.showErrorMessage(`PYRo Wiki pull failed: ${errorMessage(error)}`)
  }
}

export async function saveDraftCurrent(context: vscode.ExtensionContext, auth: AuthManager, document = vscode.window.activeTextEditor?.document): Promise<void> {
  if (!document || !isWikiDocument(document)) return void vscode.window.showWarningMessage('Current document is outside the PYRo Wiki root.')
  const client = makeClient(document, auth)
  if (!client) return
  const baseRevision = context.workspaceState.get<number>(revisionKey(document), 0)
  try {
    const result = await client.saveDraft(documentPath(document), document.getText(), baseRevision)
    await context.workspaceState.update(revisionKey(document), result.revision)
    void vscode.window.showInformationMessage(`Saved cloud draft revision ${result.revision}.`)
  } catch (error) {
    if ((error as { status?: number }).status === 401) void vscode.window.showWarningMessage('Sign in with Feishu before saving a cloud draft.')
    else if (isTransient(error)) void vscode.window.showWarningMessage('PYRo Wiki is temporarily unreachable. The draft was not uploaded; try again later.')
    else void vscode.window.showErrorMessage(`PYRo Wiki draft save failed: ${errorMessage(error)}`)
  }
}

export async function viewCurrentRevisions(auth: AuthManager, document = vscode.window.activeTextEditor?.document): Promise<void> {
  if (!document || !isWikiDocument(document)) return void vscode.window.showWarningMessage('Current document is outside the PYRo Wiki root.')
  const client = makeClient(document, auth)
  if (!client) return
  try {
    const revisions = (await client.revisions(documentPath(document))).revisions
    if (!revisions.length) return void vscode.window.showInformationMessage('This document has no cloud revisions yet.')
    const picked = await vscode.window.showQuickPick(revisions.map((revision) => ({
      label: `Revision ${revision.revision}`,
      description: revision.updatedAt,
      revision
    })), { placeHolder: `Select a cloud revision of ${document.fileName}` })
    if (!picked) return
    const remote = await vscode.workspace.openTextDocument({ content: picked.revision.content, language: 'markdown' })
    await vscode.commands.executeCommand('vscode.diff', document.uri, remote.uri, `PYRo: ${document.fileName} revision ${picked.revision.revision}`)
  } catch (error) {
    if ((error as { status?: number }).status === 401) void vscode.window.showWarningMessage('Sign in with Feishu before viewing cloud revisions.')
    else void vscode.window.showErrorMessage(`Could not load cloud revisions: ${errorMessage(error)}`)
  }
}
