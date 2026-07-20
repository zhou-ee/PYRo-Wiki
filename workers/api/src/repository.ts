export interface RepositoryEnv {
  PYRO_GITHUB_REPOSITORY_URL?: string
  PYRO_GITHUB_BRANCH?: string
  GITHUB_TOKEN?: string
}

export interface GitHubRepositoryRef {
  repositoryUrl: string
  owner: string
  repo: string
  branch: string
}

const DEFAULT_REPOSITORY_URL = 'https://github.com/zhou-ee/PYRo-Wiki'
const DEFAULT_BRANCH = 'main'

export function parseGitHubRepository(env: RepositoryEnv): GitHubRepositoryRef {
  const repositoryUrl = (env.PYRO_GITHUB_REPOSITORY_URL || DEFAULT_REPOSITORY_URL).replace(/\/$/, '')
  const parsed = new URL(repositoryUrl)
  if (parsed.hostname.toLowerCase() !== 'github.com') throw new Error('PYRO_GITHUB_REPOSITORY_URL must point to github.com')
  const segments = parsed.pathname.split('/').filter(Boolean)
  if (segments.length < 2) throw new Error('PYRO_GITHUB_REPOSITORY_URL must include owner and repository name')
  const repo = segments[1].replace(/\.git$/, '')
  if (!segments[0] || !repo) throw new Error('GitHub repository owner and name are required')
  return { repositoryUrl, owner: segments[0], repo, branch: env.PYRO_GITHUB_BRANCH || DEFAULT_BRANCH }
}

export function githubArchiveUrl(repository: GitHubRepositoryRef): string {
  return `https://codeload.github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/tar.gz/${encodeURIComponent(repository.branch)}`
}

function upstreamHeaders(env: RepositoryEnv): Headers {
  const headers = new Headers({ accept: 'application/vnd.github+json', 'user-agent': 'PYRo-Wiki-Worker' })
  if (env.GITHUB_TOKEN) headers.set('authorization', `Bearer ${env.GITHUB_TOKEN}`)
  return headers
}

function errorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' } })
}

export async function fetchRepositoryArchive(env: RepositoryEnv): Promise<Response> {
  let repository: GitHubRepositoryRef
  try {
    repository = parseGitHubRepository(env)
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Invalid GitHub repository configuration', 500)
  }
  let upstream: Response
  try {
    upstream = await fetch(githubArchiveUrl(repository), { headers: upstreamHeaders(env) })
  } catch {
    return errorResponse('GitHub repository archive request failed', 502)
  }
  if (!upstream.ok || !upstream.body) return errorResponse(`GitHub repository archive returned HTTP ${upstream.status}`, 502)
  const headers = new Headers(upstream.headers)
  headers.set('content-type', 'application/gzip')
  headers.set('cache-control', 'public, max-age=60, s-maxage=300')
  headers.set('access-control-allow-origin', '*')
  headers.set('access-control-allow-headers', 'content-type, authorization')
  headers.set('x-pyro-repository-ref', repository.branch)
  return new Response(upstream.body, { status: 200, headers })
}

export { DEFAULT_BRANCH, DEFAULT_REPOSITORY_URL }
