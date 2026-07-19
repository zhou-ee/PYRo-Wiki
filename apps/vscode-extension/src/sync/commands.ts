import * as vscode from 'vscode'
import * as path from 'node:path'
import { ApiClient } from './api'
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

function documentPath(document: vscode.TextDocument): string {
  return path.relative(workspaceRoot(document)!, document.uri.fsPath).replaceAll('\\', '/')
}

export async function pushCurrent(context: vscode.ExtensionContext, auth: AuthManager, document = vscode.window.activeTextEditor?.document): Promise<void> {
  if (!document || !isWikiDocument(document)) return void vscode.window.showWarningMessage('Current document is outside the PYRo Wiki root.')
  const client = makeClient(document, auth)
  if (!client) return
  const key = `pyroWiki.revision.${document.uri.toString()}`
  const baseRevision = context.workspaceState.get<number>(key, 0)
  try {
    const result = await client.putDocument(documentPath(document), document.getText(), baseRevision)
    await context.workspaceState.update(key, result.revision)
    void vscode.window.showInformationMessage(`Uploaded revision ${result.revision}.`)
  } catch (error) {
    if ((error as { status?: number }).status === 409) {
      const body = (error as { body?: { remote?: { content: string; revision: number }; common?: { content: string; revision: number } | null } }).body
      const remote = await vscode.workspace.openTextDocument({ content: body?.remote?.content ?? '', language: 'markdown' })
      await vscode.commands.executeCommand('vscode.diff', document.uri, remote.uri, 'PYRo Wiki: Local / Remote Conflict')
      void vscode.window.showWarningMessage('Remote document changed. Review the diff before pushing again.')
    } else if ((error as { status?: number }).status === 401) {
      void vscode.window.showWarningMessage('Sign in with Feishu before pushing a document.')
    } else void vscode.window.showErrorMessage(`PYRo Wiki upload failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function pullCurrent(context: vscode.ExtensionContext, auth: AuthManager, document = vscode.window.activeTextEditor?.document): Promise<void> {
  if (!document || !isWikiDocument(document)) return void vscode.window.showWarningMessage('Current document is outside the PYRo Wiki root.')
  const client = makeClient(document, auth)
  if (!client) return
  try {
    const remote = await client.getDocument(documentPath(document))
    const edit = new vscode.WorkspaceEdit()
    const endLine = Math.max(0, document.lineCount - 1)
    edit.replace(document.uri, new vscode.Range(0, 0, endLine, document.lineAt(endLine).text.length), remote.content)
    await vscode.workspace.applyEdit(edit)
    await document.save()
    await context.workspaceState.update(`pyroWiki.revision.${document.uri.toString()}`, remote.revision)
    void vscode.window.showInformationMessage(`Pulled revision ${remote.revision}.`)
  } catch (error) {
    if ((error as { status?: number }).status === 401) void vscode.window.showWarningMessage('Sign in with Feishu before pulling a document.')
    else void vscode.window.showErrorMessage(`PYRo Wiki pull failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
