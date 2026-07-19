import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import * as http from 'node:http'
import WebSocket from 'ws'
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
      expect(response.body).toContain('window.scrollTo')
      expect(response.body).toContain('activeHeading')
      expect(response.body).toContain('atBottom')
      expect(response.body).toContain('pageKey')
      expect(response.body).toContain('previewNavigate')
      expect(response.body).toContain('popstate')
      expect(response.body).toContain('/@vite/client')
      expect(response.body).not.toContain('Unsupported component')
      const shell = server.document(url, 'vscode-webview://test')
      expect(shell).toContain('vitepress-frame')
      expect(shell).toContain('pendingSourceScroll')
      const route = new URL(url)
      const socket = new WebSocket(`ws://${route.host}/`)
      await new Promise<void>((resolvePromise, reject) => {
        const timer = setTimeout(() => { socket.terminate(); reject(new Error('VitePress HMR WebSocket did not connect')) }, 5_000)
        socket.once('open', () => { clearTimeout(timer); resolvePromise() })
        socket.once('error', (error) => { clearTimeout(timer); reject(error) })
      })
      socket.terminate()
    } finally {
      await server.disposeAsync()
    }
  }, 45_000)
})
