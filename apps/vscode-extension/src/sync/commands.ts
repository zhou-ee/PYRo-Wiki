import * as vscode from 'vscode'
import * as path from 'node:path'
import { ApiClient } from './api'
import { isWikiDocument, workspaceRoot } from '../workspace'

export function makeClient(document: vscode.TextDocument): ApiClient | undefined {
  const root = workspaceRoot(document)
  if (!root) return undefined
  const baseUrl = vscode.workspace.getConfiguration('pyroWiki').get<string>('apiBaseUrl', 'http://127.0.0.1:8787')
  const workspaceId = path.basename(root).replace(/[^A-Za-z0-9_-]/g, '-').toLowerCase() || 'default'
  return new ApiClient(baseUrl, workspaceId)
}

export async function pushCurrent(context: vscode.ExtensionContext, document = vscode.window.activeTextEditor?.document): Promise<void> {
  if (!document || !isWikiDocument(document)) return void vscode.window.showWarningMessage('Current document is outside the PYRo Wiki root.')
  const client = makeClient(document)
  if (!client) return
  const key = `pyroWiki.revision.${document.uri.toString()}`
  const baseRevision = context.workspaceState.get<number>(key, 0)
  try {
    const result = await client.putDocument(path.relative(workspaceRoot(document)!, document.uri.fsPath).replaceAll('\\', '/'), document.getText(), baseRevision)
    await context.workspaceState.update(key, result.revision)
    void vscode.window.showInformationMessage(`Uploaded revision ${result.revision}.`)
  } catch (error) {
    if ((error as { status?: number }).status === 409) {
      const body = (error as { body?: { remote?: { content: string; revision: number }; common?: { content: string; revision: number } | null } }).body
      const remote = await vscode.workspace.openTextDocument({ content: body?.remote?.content ?? '', language: 'markdown' })
      await vscode.commands.executeCommand('vscode.diff', document.uri, remote.uri, 'PYRo Wiki: Local ↔ Remote Conflict')
      void vscode.window.showWarningMessage('Remote document changed. Review the diff before pushing again.')
    } else void vscode.window.showErrorMessage(`PYRo Wiki upload failed: ${String(error)}`)
  }
}

export async function pullCurrent(context: vscode.ExtensionContext, document = vscode.window.activeTextEditor?.document): Promise<void> {
  if (!document || !isWikiDocument(document)) return void vscode.window.showWarningMessage('Current document is outside the PYRo Wiki root.')
  const client = makeClient(document)
  if (!client) return
  const documentPath = path.relative(workspaceRoot(document)!, document.uri.fsPath).replaceAll('\\', '/')
  try {
    const remote = await client.getDocument(documentPath)
    const edit = new vscode.WorkspaceEdit()
    edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, document.lineAt(document.lineCount - 1).text.length), remote.content)
    await vscode.workspace.applyEdit(edit)
    await document.save()
    await context.workspaceState.update(`pyroWiki.revision.${document.uri.toString()}`, remote.revision)
    void vscode.window.showInformationMessage(`Pulled revision ${remote.revision}.`)
  } catch (error) { void vscode.window.showErrorMessage(`PYRo Wiki pull failed: ${String(error)}`) }
}
