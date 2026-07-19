import * as vscode from 'vscode'

export interface PendingSyncItem {
  id: string
  uri: string
  path: string
  workspaceId: string
  content: string
  baseRevision: number
  queuedAt: string
}

const QUEUE_KEY = 'pyroWiki.syncQueue'

export async function pendingSyncItems(context: vscode.ExtensionContext): Promise<PendingSyncItem[]> {
  return context.workspaceState.get<PendingSyncItem[]>(QUEUE_KEY, [])
}

export async function enqueueSync(context: vscode.ExtensionContext, item: Omit<PendingSyncItem, 'id' | 'queuedAt'>): Promise<void> {
  const current = await pendingSyncItems(context)
  const id = item.uri
  const next = current.filter((queued) => queued.id !== id)
  next.push({ ...item, id, queuedAt: new Date().toISOString() })
  await context.workspaceState.update(QUEUE_KEY, next)
}

export async function removeSync(context: vscode.ExtensionContext, id: string): Promise<void> {
  const current = await pendingSyncItems(context)
  await context.workspaceState.update(QUEUE_KEY, current.filter((item) => item.id !== id))
}

export async function pendingSyncCount(context: vscode.ExtensionContext): Promise<number> {
  return (await pendingSyncItems(context)).length
}
