import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { gunzipSync } from 'node:zlib'

const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024
const MAX_NETWORK_ATTEMPTS = 3

export interface SharedRepositoryPullResult {
  created: number
  replaced: number
  skipped: number
  files: string[]
}

function sleep(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)) }

function safeRelativePath(value: string): string | undefined {
  const normalized = value.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+/g, '/')
  if (!normalized || normalized.startsWith('../') || normalized.includes('/../') || normalized === '..') return undefined
  if (path.posix.isAbsolute(normalized)) return undefined
  const withoutArchiveRoot = normalized.split('/').slice(1).join('/')
  if (!withoutArchiveRoot || withoutArchiveRoot === '.git' || withoutArchiveRoot.startsWith('.git/')) return undefined
  return withoutArchiveRoot
}

function readTarString(buffer: Uint8Array, start: number, length: number): string {
  const bytes = buffer.subarray(start, start + length)
  const zero = bytes.indexOf(0)
  return new TextDecoder().decode(zero >= 0 ? bytes.subarray(0, zero) : bytes).trim()
}

function readTarSize(buffer: Uint8Array): number {
  const raw = readTarString(buffer, 124, 12).replace(/\0/g, '').trim()
  return raw ? Number.parseInt(raw, 8) : 0
}

function parseTarArchive(compressed: Uint8Array): Map<string, Uint8Array> {
  if (compressed.byteLength > MAX_ARCHIVE_BYTES) throw new Error('Shared Wiki archive exceeds the 200 MB limit.')
  const buffer = gunzipSync(compressed)
  const files = new Map<string, Uint8Array>()
  let offset = 0
  while (offset + 512 <= buffer.byteLength) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = readTarString(header, 0, 100)
    const prefix = readTarString(header, 345, 155)
    const archivePath = prefix ? `${prefix}/${name}` : name
    const size = readTarSize(header)
    const type = header[156]
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    if (dataEnd > buffer.byteLength) throw new Error('Shared Wiki archive is truncated.')
    if (type === 0 || type === 48) {
      const relativePath = safeRelativePath(archivePath)
      if (relativePath) files.set(relativePath, buffer.slice(dataStart, dataEnd))
    }
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return files
}

async function downloadArchive(apiBaseUrl: string): Promise<Uint8Array> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_NETWORK_ATTEMPTS; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60_000)
    try {
      const response = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/repository/archive`, {
        headers: { accept: 'application/gzip' },
        signal: controller.signal
      })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(body || `Worker repository proxy returned HTTP ${response.status}`)
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (!bytes.byteLength) throw new Error('Worker returned an empty shared Wiki archive.')
      return bytes
    } catch (error) {
      lastError = error
      if (attempt < MAX_NETWORK_ATTEMPTS) await sleep(400 * 2 ** (attempt - 1))
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Shared Wiki download failed.')
}

export async function pullSharedRepository(root: string, apiBaseUrl: string, overwrite = false): Promise<SharedRepositoryPullResult> {
  const archive = parseTarArchive(await downloadArchive(apiBaseUrl))
  let created = 0
  let replaced = 0
  let skipped = 0
  const files: string[] = []
  for (const [relativePath, content] of archive) {
    const target = path.resolve(root, relativePath)
    const relativeTarget = path.relative(root, target)
    if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) continue
    let exists = true
    try { await fs.access(target) } catch { exists = false }
    if (exists && !overwrite) {
      skipped += 1
      continue
    }
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content)
    if (exists) replaced += 1
    else created += 1
    files.push(relativePath)
  }
  if (!files.length && !archive.size) throw new Error('Shared Wiki archive contained no usable files.')
  return { created, replaced, skipped, files }
}

export { parseTarArchive, safeRelativePath }
