import type { AuthUser } from './auth'
import { getGitHubBranchSha, GitHubPublishError, publishGitHubFile } from './github'
import { getRepositoryMetadataValue, type RepositoryEnv } from './repository'

export type PublishStatus = 'draft' | 'submitted' | 'approved' | 'publishing' | 'published' | 'rejected' | 'conflict' | 'failed'
export interface PublishRequestRow {
  id: string
  workspaceId: string
  documentPath: string
  revision: number
  baseGithubSha: string
  requesterId: string
  status: PublishStatus
  reviewBy?: string
  reviewMessage?: string
  githubCommitSha?: string
  errorMessage?: string
  createdAt: string
  updatedAt: string
  submittedAt?: string
  approvedAt?: string
  publishedAt?: string
}

interface PublishEnv extends RepositoryEnv { PYRO_PUBLISHER_IDS?: string; PYRO_ENVIRONMENT?: string }
type JsonRecord = Record<string, unknown>

function row(value: JsonRecord): PublishRequestRow {
  return {
    id: String(value.id), workspaceId: String(value.workspaceId), documentPath: String(value.documentPath), revision: Number(value.revision),
    baseGithubSha: String(value.baseGithubSha), requesterId: String(value.requesterId), status: value.status as PublishStatus,
    reviewBy: value.reviewBy ? String(value.reviewBy) : undefined, reviewMessage: value.reviewMessage ? String(value.reviewMessage) : undefined,
    githubCommitSha: value.githubCommitSha ? String(value.githubCommitSha) : undefined, errorMessage: value.errorMessage ? String(value.errorMessage) : undefined,
    createdAt: String(value.createdAt), updatedAt: String(value.updatedAt), submittedAt: value.submittedAt ? String(value.submittedAt) : undefined,
    approvedAt: value.approvedAt ? String(value.approvedAt) : undefined, publishedAt: value.publishedAt ? String(value.publishedAt) : undefined
  }
}

export function isPublisher(env: PublishEnv, user: AuthUser): boolean {
  if (env.PYRO_ENVIRONMENT !== 'production' && user.id === 'dev-anonymous') return true
  const ids = (env.PYRO_PUBLISHER_IDS || '').split(',').map((value) => value.trim()).filter(Boolean)
  return ids.includes(user.id) || ids.includes(user.openId)
}

function selectSql(where: string): string {
  return `SELECT id, workspace_id as workspaceId, document_path as documentPath, revision, base_github_sha as baseGithubSha,
    requester_id as requesterId, status, review_by as reviewBy, review_message as reviewMessage,
    github_commit_sha as githubCommitSha, error_message as errorMessage, created_at as createdAt,
    updated_at as updatedAt, submitted_at as submittedAt, approved_at as approvedAt, published_at as publishedAt
    FROM publish_requests WHERE ${where}`
}

export async function getPublishRequest(db: D1Database, id: string): Promise<PublishRequestRow | undefined> {
  const value = await db.prepare(selectSql('id=?')).bind(id).first<JsonRecord>()
  return value ? row(value) : undefined
}

export async function listPublishRequests(db: D1Database, user: AuthUser, env: PublishEnv, workspace: string): Promise<PublishRequestRow[]> {
  const publisher = isPublisher(env, user)
  const query = publisher ? selectSql('workspace_id=? ORDER BY updated_at DESC LIMIT 100') : selectSql('workspace_id=? AND requester_id=? ORDER BY updated_at DESC LIMIT 100')
  const result = publisher ? await db.prepare(query).bind(workspace).all<JsonRecord>() : await db.prepare(query).bind(workspace, user.id).all<JsonRecord>()
  return (result.results ?? []).map(row)
}

export async function createPublishRequest(db: D1Database, env: PublishEnv, user: AuthUser, input: { workspace: string; documentPath: string; revision: number }): Promise<PublishRequestRow> {
  const document = await db.prepare('SELECT d.current_revision as revision FROM documents d WHERE d.id=?').bind(`${input.workspace}:${input.documentPath}`).first<{ revision: number }>()
  if (!document) throw new Error('Document not found')
  if (Number(document.revision) !== input.revision) throw new Error(`Document revision is ${document.revision}; refresh before submitting`)
  const metadata = await getRepositoryMetadataValue(env)
  const id = crypto.randomUUID()
  const timestamp = new Date().toISOString()
  await db.prepare(`INSERT INTO publish_requests
    (id, workspace_id, document_path, revision, base_github_sha, requester_id, status, created_at, updated_at, submitted_at)
    VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?)`)
    .bind(id, input.workspace, input.documentPath, input.revision, metadata.commitSha, user.id, timestamp, timestamp, timestamp).run()
  return (await getPublishRequest(db, id))!
}

export async function rejectPublishRequest(db: D1Database, env: PublishEnv, user: AuthUser, id: string, message: string): Promise<PublishRequestRow> {
  if (!isPublisher(env, user)) throw new Error('Publisher permission required')
  const request = await getPublishRequest(db, id)
  if (!request) throw new Error('Publish request not found')
  if (!['submitted', 'approved', 'conflict', 'failed'].includes(request.status)) throw new Error(`Cannot reject request in ${request.status} status`)
  const timestamp = new Date().toISOString()
  await db.prepare('UPDATE publish_requests SET status=\'rejected\', review_by=?, review_message=?, updated_at=? WHERE id=?').bind(user.id, message || null, timestamp, id).run()
  return (await getPublishRequest(db, id))!
}

export async function retryPublishRequest(db: D1Database, env: PublishEnv, user: AuthUser, id: string): Promise<PublishRequestRow> {
  const request = await getPublishRequest(db, id)
  if (!request) throw new Error('Publish request not found')
  if (request.requesterId !== user.id && !isPublisher(env, user)) throw new Error('You can only retry your own publish request')
  if (!['failed', 'conflict', 'rejected'].includes(request.status)) throw new Error(`Cannot retry request in ${request.status} status`)
  const timestamp = new Date().toISOString()
  await db.prepare('UPDATE publish_requests SET status=\'submitted\', error_message=NULL, review_message=NULL, updated_at=?, submitted_at=? WHERE id=?').bind(timestamp, timestamp, id).run()
  return (await getPublishRequest(db, id))!
}

export async function approveAndPublish(db: D1Database, env: PublishEnv, user: AuthUser, id: string, message?: string): Promise<PublishRequestRow> {
  if (!isPublisher(env, user)) throw new Error('Publisher permission required')
  const request = await getPublishRequest(db, id)
  if (!request) throw new Error('Publish request not found')
  if (!['submitted', 'approved', 'failed'].includes(request.status)) throw new Error(`Cannot approve request in ${request.status} status`)
  const document = await db.prepare('SELECT current_revision as revision FROM documents WHERE id=?').bind(`${request.workspaceId}:${request.documentPath}`).first<{ revision: number }>()
  if (!document || Number(document.revision) !== request.revision) {
    await db.prepare('UPDATE publish_requests SET status=\'conflict\', error_message=?, updated_at=? WHERE id=?').bind('D1 document revision changed before publishing', new Date().toISOString(), id).run()
    throw new Error('Publish request revision conflict')
  }
  let currentGithubSha: string
  try {
    currentGithubSha = await getGitHubBranchSha(env)
  } catch (cause) {
    const messageText = cause instanceof GitHubPublishError ? cause.message : cause instanceof Error ? cause.message : String(cause)
    await db.prepare('UPDATE publish_requests SET status=\'failed\', error_message=?, updated_at=? WHERE id=?').bind(messageText, new Date().toISOString(), id).run()
    throw cause
  }
  if (currentGithubSha !== request.baseGithubSha) {
    await db.prepare('UPDATE publish_requests SET status=\'conflict\', error_message=?, updated_at=? WHERE id=?').bind(`GitHub main changed from ${request.baseGithubSha} to ${currentGithubSha}`, new Date().toISOString(), id).run()
    throw new Error('GitHub main changed before publishing')
  }
  const revision = await db.prepare('SELECT content FROM revisions WHERE document_id=? AND revision=?').bind(`${request.workspaceId}:${request.documentPath}`, request.revision).first<{ content: string }>()
  if (!revision) throw new Error('Requested D1 revision not found')
  const timestamp = new Date().toISOString()
  await db.prepare('UPDATE publish_requests SET status=\'publishing\', review_by=?, review_message=?, approved_at=?, updated_at=? WHERE id=?').bind(user.id, message || null, timestamp, timestamp, id).run()
  try {
    const published = await publishGitHubFile(env, request.documentPath, revision.content, `docs(${request.documentPath}): publish revision ${request.revision}`)
    const publishedAt = new Date().toISOString()
    await db.prepare('UPDATE publish_requests SET status=\'published\', github_commit_sha=?, published_at=?, updated_at=?, error_message=NULL WHERE id=?').bind(published.commitSha, publishedAt, publishedAt, id).run()
  } catch (cause) {
    const messageText = cause instanceof GitHubPublishError ? cause.message : cause instanceof Error ? cause.message : String(cause)
    await db.prepare('UPDATE publish_requests SET status=\'failed\', error_message=?, updated_at=? WHERE id=?').bind(messageText, new Date().toISOString(), id).run()
    throw cause
  }
  return (await getPublishRequest(db, id))!
}
