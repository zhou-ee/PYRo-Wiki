import * as vscode from 'vscode'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function gitRoot(folder: vscode.WorkspaceFolder): Promise<string> {
  try {
    const result = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: folder.uri.fsPath, windowsHide: true, maxBuffer: 1024 * 1024 })
    return result.stdout.trim() || folder.uri.fsPath
  } catch {
    return folder.uri.fsPath
  }
}

export async function pullRepository(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (!folder) {
    void vscode.window.showWarningMessage('Open a Git repository before pulling the PYRo Wiki repository.')
    return
  }
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'PYRo Wiki: Pulling repository...', cancellable: false }, async () => {
    const cwd = await gitRoot(folder)
    try {
      const result = await execFileAsync('git', ['pull', '--ff-only'], { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
      await vscode.commands.executeCommand('git.refresh')
      void vscode.window.showInformationMessage(`Repository updated. ${result.stdout.trim() || 'Already up to date.'}`)
    } catch (cause) {
      const error = cause as { stderr?: string; stdout?: string; message?: string }
      const details = (error.stderr || error.stdout || error.message || 'git pull failed').trim()
      void vscode.window.showErrorMessage(`PYRo Wiki repository pull failed: ${details}`, 'Show Output').then((choice) => {
        if (choice === 'Show Output') void vscode.window.showInformationMessage(details)
      })
    }
  })
}

export async function showRepositoryStatus(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (!folder) return void vscode.window.showWarningMessage('Open a Git repository first.')
  const cwd = await gitRoot(folder)
  try {
    const result = await execFileAsync('git', ['status', '--short', '--branch'], { cwd, windowsHide: true, maxBuffer: 1024 * 1024 })
    const status = result.stdout.trim() || 'Working tree clean.'
    const channel = vscode.window.createOutputChannel('PYRo Wiki Git')
    channel.clear()
    channel.appendLine(status)
    channel.show(true)
  } catch (cause) {
    void vscode.window.showErrorMessage(`Unable to read repository status: ${String(cause)}`)
  }
}

export function createRepositoryStatusItem(context: vscode.ExtensionContext): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  item.text = '$(sync) PYRo Pull'
  item.tooltip = 'PYRo Wiki: Pull repository (fast-forward only)'
  item.command = 'pyroWiki.pullRepository'
  item.show()
  context.subscriptions.push(item)
  return item
}
