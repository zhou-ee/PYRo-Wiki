import type { RepositoryEnv } from './repository'
import { githubApiUrl, parseGitHubRepository } from './repository'

export class GitHubPublishError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) { super(message); this.name = 'GitHubPublishError' }
}

const APP_TOKEN_TTL_MS = 9 * 60 * 1000
const REQUEST_TIMEOUT_MS = 20_000
const MAX_ATTEMPTS = 3
let installationTokenCache: { value: string; expiresAt: number } | undefined

function base64UrlBytes(value: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < value.length; offset += chunk) binary += String.fromCharCode(...value.subarray(offset, offset + chunk))
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
}
function base64UrlText(value: string): string { return base64UrlBytes(new TextEncoder().encode(value)) }
function base64Text(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  return btoa(binary)
}
function derLength(length: number): Uint8Array {
  if (length < 128) return Uint8Array.of(length)
  const bytes: number[] = []
  let value = length
  while (value > 0) { bytes.unshift(value & 0xff); value >>>= 8 }
  return Uint8Array.of(0x80 | bytes.length, ...bytes)
}
function wrapPkcs1AsPkcs8(pkcs1: Uint8Array): Uint8Array {
  const algorithm = Uint8Array.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00])
  const version = Uint8Array.from([0x02, 0x01, 0x00])
  const octetLength = derLength(pkcs1.byteLength)
  const octet = new Uint8Array(1 + octetLength.byteLength + pkcs1.byteLength)
  octet[0] = 0x04
  octet.set(octetLength, 1)
  octet.set(pkcs1, 1 + octetLength.byteLength)
  const sequenceLength = derLength(version.byteLength + algorithm.byteLength + octet.byteLength)
  const result = new Uint8Array(1 + sequenceLength.byteLength + version.byteLength + algorithm.byteLength + octet.byteLength)
  let offset = 0
  result[offset++] = 0x30
  result.set(sequenceLength, offset); offset += sequenceLength.byteLength
  result.set(version, offset); offset += version.byteLength
  result.set(algorithm, offset); offset += algorithm.byteLength
  result.set(octet, offset)
  return result
}
function decodePem(value: string): Uint8Array {
  const normalized = value.replaceAll('\\n', '\n')
  const pkcs1 = /BEGIN RSA PRIVATE KEY/.test(normalized)
  const body = normalized.replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/g, '').replace(/-----END (?:RSA )?PRIVATE KEY-----/g, '').replace(/\s+/g, '')
  const decoded = Uint8Array.from(atob(body), (character) => character.charCodeAt(0))
  return pkcs1 ? wrapPkcs1AsPkcs8(decoded) : decoded
}
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }

async function appJwt(env: RepositoryEnv): Promise<string> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) throw new GitHubPublishError('GitHub App publishing is not configured', 503, 'GITHUB_APP_NOT_CONFIGURED')
  const header = base64UrlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const issuedAt = Math.floor(Date.now() / 1000) - 60
  const payload = base64UrlText(JSON.stringify({ iat: issuedAt, exp: issuedAt + 540, iss: env.GITHUB_APP_ID }))
  const privateKeyBytes = decodePem(env.GITHUB_APP_PRIVATE_KEY)
  const privateKeyBuffer = new ArrayBuffer(privateKeyBytes.byteLength)
  new Uint8Array(privateKeyBuffer).set(privateKeyBytes)
  const key = await crypto.subtle.importKey('pkcs8', privateKeyBuffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const signingBytes = new TextEncoder().encode(`${header}.${payload}`)
  const signingBuffer = new ArrayBuffer(signingBytes.byteLength)
  new Uint8Array(signingBuffer).set(signingBytes)
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, signingBuffer)
  return `${header}.${payload}.${base64UrlBytes(new Uint8Array(signature))}`
}

async function rawGitHubRequest(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const headers = new Headers(init.headers)
    headers.set('user-agent', 'PYRo-Wiki-Worker')
    headers.set('accept', 'application/vnd.github+json')
    return await fetch(url, { ...init, headers, signal: controller.signal })
  } finally { clearTimeout(timer) }
}

async function installationToken(env: RepositoryEnv): Promise<string> {
  if (!env.GITHUB_INSTALLATION_ID) throw new GitHubPublishError('GitHub App installation is not configured', 503, 'GITHUB_APP_NOT_CONFIGURED')
  if (installationTokenCache && installationTokenCache.expiresAt > Date.now()) return installationTokenCache.value
  const jwt = await appJwt(env)
  const response = await rawGitHubRequest(`https://api.github.com/app/installations/${encodeURIComponent(env.GITHUB_INSTALLATION_ID)}/access_tokens`, { method: 'POST', headers: { authorization: `Bearer ${jwt}` } })
  if (!response.ok) throw new GitHubPublishError(`GitHub App token request returned HTTP ${response.status}`, response.status, 'GITHUB_APP_TOKEN_FAILED')
  const data = await response.json() as { token?: string; expires_at?: string }
  if (!data.token) throw new GitHubPublishError('GitHub App did not return an installation token', 502, 'GITHUB_APP_TOKEN_FAILED')
  installationTokenCache = { value: data.token, expiresAt: Math.min(Date.parse(data.expires_at || '') || Date.now() + APP_TOKEN_TTL_MS, Date.now() + APP_TOKEN_TTL_MS) - 30_000 }
  return data.token
}

async function githubRequest(url: string, env: RepositoryEnv, init: RequestInit, retryable = true): Promise<Response> {
  let lastError: unknown
  for (let attempt = 1; attempt <= (retryable ? MAX_ATTEMPTS : 1); attempt += 1) {
    try {
      const token = await installationToken(env)
      const headers = new Headers(init.headers)
      headers.set('authorization', `Bearer ${token}`)
      const response = await rawGitHubRequest(url, { ...init, headers })
      if (response.ok || !retryable || (response.status < 500 && response.status !== 429) || attempt === MAX_ATTEMPTS) return response
      lastError = new GitHubPublishError(`GitHub API returned HTTP ${response.status}`, response.status)
    } catch (error) { lastError = error }
    await sleep(300 * 2 ** (attempt - 1))
  }
  throw lastError instanceof Error ? lastError : new GitHubPublishError('GitHub API request failed', 502)
}

export async function getGitHubBranchSha(env: RepositoryEnv): Promise<string> {
  const repository = parseGitHubRepository(env)
  const response = await githubRequest(githubApiUrl(repository, `/branches/${encodeURIComponent(repository.branch)}`), env, {}, true)
  if (!response.ok) throw new GitHubPublishError(`GitHub branch lookup returned HTTP ${response.status}`, response.status, 'GITHUB_BRANCH_LOOKUP_FAILED')
  const data = await response.json() as { object?: { sha?: string } }
  if (!data.object?.sha) throw new GitHubPublishError('GitHub branch lookup did not return a SHA', 502, 'GITHUB_BRANCH_LOOKUP_FAILED')
  return data.object.sha
}

export async function publishGitHubFile(env: RepositoryEnv, documentPath: string, content: string, message: string): Promise<{ commitSha: string; branch: string }> {
  const repository = parseGitHubRepository(env)
  const encodedPath = documentPath.split('/').map(encodeURIComponent).join('/')
  const response = await githubRequest(githubApiUrl(repository, `/contents/${encodedPath}`), env, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, content: base64Text(content), branch: repository.branch })
  }, false)
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new GitHubPublishError(`GitHub file publish returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`, response.status, 'GITHUB_PUBLISH_FAILED')
  }
  const data = await response.json() as { commit?: { sha?: string } }
  if (!data.commit?.sha) throw new GitHubPublishError('GitHub publish did not return a commit SHA', 502, 'GITHUB_PUBLISH_FAILED')
  return { commitSha: data.commit.sha, branch: repository.branch }
}
