import * as vscode from 'vscode'
import * as path from 'node:path'
import { ApiClient, ApiError, type ConflictResponse } from './api'
import { enqueueSync, pendingSyncItems, removeSync } from './queue'
import type { AuthManager } from '../auth/session'
import { isWikiDocument, workspaceRoot } from '../workspace'
import { mergeThreeWay } from './merge'

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
  if (!common) {
    const conflictChoice = await vscode.window.showWarningMessage('No common cloud ancestor is available. Apply explicit conflict markers to the local file for manual resolution?', { modal: true }, 'Apply conflict markers')
    if (conflictChoice !== 'Apply conflict markers') return
    await replaceDocument(document, mergeThreeWay('', conflict.local.content, remote.content ?? '').content)
    await document.save()
    void vscode.window.showWarningMessage(`Conflict markers were inserted into ${document.fileName}. Resolve them, then Push using cloud revision ${remote.revision} as the base.`)
    return
  }

  const merged = mergeThreeWay(common.content, conflict.local.content, remote.content ?? '')
  if (merged.conflicts === 0) {
    const mergeChoice = await vscode.window.showInformationMessage('The local and remote changes can be merged automatically.', 'Apply and push', 'Apply only', 'Cancel')
    if (mergeChoice === 'Cancel' || !mergeChoice) return
    await replaceDocument(document, merged.content)
    await document.save()
    await context.workspaceState.update(revisionKey(document), remote.revision)
    if (mergeChoice === 'Apply only') {
      void vscode.window.showInformationMessage(`Applied the merged content locally. Cloud revision ${remote.revision} is now the push base.`)
      return
    }
    try {
      const result = await client.putDocument(documentPath(document), merged.content, remote.revision)
      await context.workspaceState.update(revisionKey(document), result.revision)
      void vscode.window.showInformationMessage(`Merged and uploaded revision ${result.revision}.`)
    } catch (error) {
      void vscode.window.showWarningMessage(`The cloud document changed again; review the conflict once more. ${errorMessage(error)}`)
    }
    return
  }

  const conflictChoice = await vscode.window.showWarningMessage(`The three-way merge contains ${merged.conflicts} conflict${merged.conflicts === 1 ? '' : 's'}. Apply conflict markers to the local file?`, { modal: true }, 'Apply conflict markers')
  if (conflictChoice !== 'Apply conflict markers') return
  await replaceDocument(document, merged.content)
  await document.save()
  await context.workspaceState.update(revisionKey(document), remote.revision)
  void vscode.window.showWarningMessage(`Applied ${merged.conflicts} conflict marker${merged.conflicts === 1 ? '' : 's'} to ${document.fileName}. Resolve them, then Push using cloud revision ${remote.revision} as the base.`)
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
    const status = (error as { status?: number }).status
    if (status === 401) void vscode.window.showWarningMessage('Sign in with Feishu before pulling a document.')
    else if (status === 404) {
      const choice = await vscode.window.showWarningMessage(`Cloud document ${documentPath(document)} does not exist yet. Upload the current local content as a new cloud document?`, 'Push as new cloud document')
      if (choice !== 'Push as new cloud document') return
      try {
        const result = await client.putDocument(documentPath(document), document.getText(), 0)
        await context.workspaceState.update(revisionKey(document), result.revision)
        void vscode.window.showInformationMessage(`Created cloud document ${documentPath(document)} at revision ${result.revision}.`)
      } catch (pushError) {
        void vscode.window.showErrorMessage(`Could not create cloud document: ${errorMessage(pushError)}`)
      }
    } else if (isTransient(error)) void vscode.window.showWarningMessage('PYRo Wiki is temporarily unreachable. Try Pull again when the network is available.')
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

function publishStatusLabel(status: string): string {
  return ({ draft: '草稿', submitted: '等待审核', approved: '审核通过', publishing: '正在发布', published: '已发布到 GitHub', rejected: '已拒绝', conflict: '发布冲突', failed: '发布失败' } as Record<string, string>)[status] || status
}

export async function submitPublishRequestCurrent(context: vscode.ExtensionContext, auth: AuthManager, document = vscode.window.activeTextEditor?.document): Promise<void> {
  if (!document || !isWikiDocument(document)) return void vscode.window.showWarningMessage('当前文档不在 PYRo Wiki 工作区内。')
  const client = makeClient(document, auth)
  if (!client) return
  const revision = context.workspaceState.get<number>(revisionKey(document), 0)
  if (!revision) return void vscode.window.showWarningMessage('请先使用“PYRo Wiki: Save Cloud Draft”保存云端草稿，再提交发布申请。')
  try {
    const result = await client.submitPublishRequest(documentPath(document), revision)
    void vscode.window.showInformationMessage(`发布申请已提交：${documentPath(document)}，revision ${result.request.revision}，等待审核。`)
  } catch (error) {
    if ((error as { status?: number }).status === 401) void vscode.window.showWarningMessage('提交发布申请前请先使用飞书登录。')
    else void vscode.window.showErrorMessage(`提交发布申请失败：${errorMessage(error)}`)
  }
}

async function choosePublishRequest(client: ApiClient): Promise<import('./api').PublishRequest | undefined> {
  const requests = (await client.publishRequests()).requests
  if (!requests.length) { void vscode.window.showInformationMessage('当前没有发布申请。'); return undefined }
  const picked = await vscode.window.showQuickPick(requests.map((request) => ({
    label: `${publishStatusLabel(request.status)}  ${request.documentPath}`,
    description: `revision ${request.revision} · ${request.updatedAt}`,
    detail: request.errorMessage || request.reviewMessage || `base GitHub SHA: ${request.baseGithubSha}`,
    request
  })), { placeHolder: '选择一个发布申请' })
  return picked?.request
}

export async function viewPublishRequests(auth: AuthManager, document = vscode.window.activeTextEditor?.document): Promise<void> {
  if (!document || !isWikiDocument(document)) return void vscode.window.showWarningMessage('请先打开 PYRo Wiki 中的 Markdown 文档。')
  const client = makeClient(document, auth)
  if (!client) return
  try { await choosePublishRequest(client) } catch (error) { void vscode.window.showErrorMessage(`读取发布申请失败：${errorMessage(error)}`) }
}

export async function approveAndPublishRequest(auth: AuthManager, document = vscode.window.activeTextEditor?.document): Promise<void> {
  if (!document || !isWikiDocument(document)) return void vscode.window.showWarningMessage('请先打开 PYRo Wiki 中的 Markdown 文档。')
  const client = makeClient(document, auth)
  if (!client) return
  try {
    const request = await choosePublishRequest(client)
    if (!request) return
    const confirmation = await vscode.window.showWarningMessage(`确认批准并发布 ${request.documentPath} revision ${request.revision}？`, { modal: true }, 'Approve and Publish')
    if (confirmation !== 'Approve and Publish') return
    const message = await vscode.window.showInputBox({ prompt: '可选：填写审核意见或发布说明', ignoreFocusOut: true })
    const result = await client.approvePublishRequest(request.id, message)
    void vscode.window.showInformationMessage(`发布完成：${result.request.documentPath}，GitHub commit ${result.request.githubCommitSha || 'unknown'}。`)
  } catch (error) {
    const status = (error as { status?: number }).status
    if (status === 403) void vscode.window.showWarningMessage('当前用户没有维护者发布权限。')
    else if (status === 409) void vscode.window.showWarningMessage(`发布冲突：${errorMessage(error)}。请同步后重新提交。`)
    else void vscode.window.showErrorMessage(`批准发布失败：${errorMessage(error)}`)
  }
}

export async function rejectPublishRequest(auth: AuthManager, document = vscode.window.activeTextEditor?.document): Promise<void> {
  if (!document || !isWikiDocument(document)) return void vscode.window.showWarningMessage('请先打开 PYRo Wiki 中的 Markdown 文档。')
  const client = makeClient(document, auth)
  if (!client) return
  try {
    const request = await choosePublishRequest(client)
    if (!request) return
    const message = await vscode.window.showInputBox({ prompt: `请输入拒绝 ${request.documentPath} 的原因`, ignoreFocusOut: true, validateInput: (value) => value.trim() ? undefined : '拒绝原因不能为空' })
    if (message === undefined) return
    await client.rejectPublishRequest(request.id, message)
    void vscode.window.showInformationMessage('发布申请已拒绝。')
  } catch (error) { void vscode.window.showErrorMessage(`拒绝发布申请失败：${errorMessage(error)}`) }
}

export async function retryPublishRequest(auth: AuthManager, document = vscode.window.activeTextEditor?.document): Promise<void> {
  if (!document || !isWikiDocument(document)) return void vscode.window.showWarningMessage('请先打开 PYRo Wiki 中的 Markdown 文档。')
  const client = makeClient(document, auth)
  if (!client) return
  try {
    const request = await choosePublishRequest(client)
    if (!request) return
    const result = await client.retryPublishRequest(request.id)
    void vscode.window.showInformationMessage(`发布申请已重新提交审核：${result.request.documentPath}。`)
  } catch (error) { void vscode.window.showErrorMessage(`重试发布申请失败：${errorMessage(error)}`) }
}
