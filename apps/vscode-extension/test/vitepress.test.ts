import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import * as http from 'node:http'
import { VitePressPreviewServer } from '../src/preview/vitepress'

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    http.get(url, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolvePromise({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    }).on('error', reject)
  })
}

describe('full VitePress preview server', () => {
  it('serves the real VitePress app and injects the scroll bridge', async () => {
    const root = resolve(__dirname, '../../..')
    const server = new VitePressPreviewServer()
    try {
      await server.start(root)
      const document = { uri: { fsPath: resolve(root, 'about_us/administrator_list.md') } } as any
      const url = server.urlFor(document)
      const response = await get(url)
      expect(response.status).toBe(200)
      expect(response.body).toContain('parentWindow.postMessage')
      expect(response.body).not.toContain('Unsupported component')
      expect(server.document(url, 'vscode-webview://test')).toContain('vitepress-frame')
    } finally {
      await server.disposeAsync()
    }
  }, 45_000)
})
