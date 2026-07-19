import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as net from 'node:net'
import * as path from 'node:path'
import type { Disposable, TextDocument } from 'vscode'

export interface VitePressPreviewServerOptions {
  extensionPath?: string
}

function findVitePressBin(workspaceRoot: string): string {
  let packageEntry: string
  try {
    packageEntry = require.resolve('vitepress', { paths: [workspaceRoot] })
  } catch {
    throw new Error('VitePress is not installed in this Wiki workspace. Install vitepress before opening the full preview.')
  }
  let directory = path.dirname(packageEntry)
  while (directory !== path.dirname(directory)) {
    const candidate = path.join(directory, 'bin', 'vitepress.js')
    if (fs.existsSync(candidate)) return candidate
    directory = path.dirname(directory)
  }
  throw new Error('The installed VitePress package does not contain its CLI entrypoint.')
}

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local preview port.')
  return address.port
}

async function waitForHttp(port: number, timeoutMs = 30_000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const request = http.get({ hostname: '127.0.0.1', port, path: '/', timeout: 1_000 }, (response) => {
          response.resume()
          response.statusCode && response.statusCode < 500 ? resolve() : reject(new Error(`HTTP ${response.statusCode}`))
        })
        request.once('error', reject)
        request.once('timeout', () => request.destroy(new Error('request timeout')))
      })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }
  throw new Error('VitePress preview server did not become ready in time.')
}

function bridgeScript(): string {
  return `<script>(function(){var parentWindow=window.parent;var ratio=function(){var e=document.scrollingElement||document.documentElement;var m=Math.max(1,e.scrollHeight-window.innerHeight);return Math.max(0,Math.min(1,e.scrollTop/m))};var programmatic=false;window.addEventListener('scroll',function(){if(!programmatic)parentWindow.postMessage({type:'previewScroll',ratio:ratio()},'*')},{passive:true});window.addEventListener('message',function(event){if(event.data&&event.data.type==='sourceScroll'){programmatic=true;var e=document.scrollingElement||document.documentElement;var m=Math.max(1,e.scrollHeight-window.innerHeight);e.scrollTop=Math.max(0,Math.min(1,event.data.ratio))*m;window.setTimeout(function(){programmatic=false},180)}});window.addEventListener('load',function(){parentWindow.postMessage({type:'previewReady'},'*')});})();</script>`
}

function webviewDocument(url: string, cspSource: string): string {
  const escapedUrl = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  const nonce = Math.random().toString(36).slice(2)
  const script = `const vscode=acquireVsCodeApi();const frame=document.getElementById('vitepress-frame');window.addEventListener('message',event=>{if(event.source===frame.contentWindow&&event.data){vscode.postMessage(event.data);return}if(event.data?.type==='sourceScroll')frame.contentWindow?.postMessage(event.data,'*');if(event.data?.type==='navigatePreview'){frame.src=event.data.url}});`
  return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://127.0.0.1:*; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><style>html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#1b1b1f}#vitepress-frame{display:block;width:100%;height:100%;border:0;background:transparent}</style></head><body><iframe id="vitepress-frame" title="PYRo Wiki VitePress Preview" src="${escapedUrl}"></iframe><script nonce="${nonce}">${script}</script></body></html>`.replace('<meta charset="UTF-8">', `<meta charset="UTF-8"><meta name="vscode-webview-resource-origin" content="${cspSource}">`)
}

export class VitePressPreviewServer implements Disposable {
  private workspaceRoot: string | undefined
  private vitePort: number | undefined
  private proxyPort: number | undefined
  private viteProcess: childProcess.ChildProcess | undefined
  private proxyServer: http.Server | undefined
  private starting: Promise<void> | undefined

  get root(): string | undefined {
    return this.workspaceRoot
  }

  get ready(): boolean {
    return Boolean(this.workspaceRoot && this.vitePort && this.proxyPort)
  }

  async start(workspaceRoot: string): Promise<void> {
    if (this.ready && this.workspaceRoot === workspaceRoot) return
    await this.disposeAsync()
    this.starting = this.startInternal(workspaceRoot)
    try {
      await this.starting
    } catch (error) {
      await this.disposeAsync()
      throw error
    } finally {
      this.starting = undefined
    }
  }

  private async startInternal(workspaceRoot: string): Promise<void> {
    const vitepressBin = findVitePressBin(workspaceRoot)
    const vitePort = await freePort()
    const viteProcess = childProcess.spawn(process.execPath, [vitepressBin, 'dev', workspaceRoot, '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
      cwd: workspaceRoot,
      env: { ...process.env, BROWSER: 'none' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.viteProcess = viteProcess
    viteProcess.stdout?.on('data', () => undefined)
    viteProcess.stderr?.on('data', () => undefined)
    viteProcess.once('exit', () => {
      if (this.viteProcess === viteProcess) {
        this.viteProcess = undefined
        this.vitePort = undefined
      }
    })
    this.vitePort = vitePort
    await waitForHttp(vitePort)

    const proxyServer = http.createServer((request, response) => this.proxyRequest(request, response))
    await new Promise<void>((resolve, reject) => {
      proxyServer.once('error', reject)
      proxyServer.listen(0, '127.0.0.1', () => resolve())
    })
    const address = proxyServer.address()
    if (!address || typeof address === 'string') {
      proxyServer.close()
      throw new Error('Could not allocate the VitePress preview bridge port.')
    }
    this.workspaceRoot = workspaceRoot
    this.proxyServer = proxyServer
    this.proxyPort = address.port
  }

  private proxyRequest(request: http.IncomingMessage, response: http.ServerResponse): void {
    if (!this.vitePort) {
      response.writeHead(503)
      response.end('VitePress preview is not ready')
      return
    }
    const upstream = http.request({
      hostname: '127.0.0.1',
      port: this.vitePort,
      method: request.method,
      path: request.url,
      headers: { ...request.headers, host: `127.0.0.1:${this.vitePort}` }
    }, (upstreamResponse) => {
      const contentType = String(upstreamResponse.headers['content-type'] ?? '')
      if (!contentType.includes('text/html')) {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
        upstreamResponse.pipe(response)
        return
      }
      const chunks: Buffer[] = []
      upstreamResponse.on('data', (chunk: Buffer) => chunks.push(chunk))
      upstreamResponse.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8')
        body = body.replace(/<script[^>]+src=[\"']\/\@vite\/client[\"'][^>]*><\/script>/g, '')
        body = body.replace('</head>', `${bridgeScript()}</head>`)
        const headers = { ...upstreamResponse.headers }
        delete headers['content-length']
        delete headers['content-encoding']
        response.writeHead(upstreamResponse.statusCode ?? 200, headers)
        response.end(body)
      })
    })
    upstream.once('error', () => {
      if (!response.headersSent) response.writeHead(502)
      response.end('Unable to reach VitePress preview server')
    })
    request.pipe(upstream)
  }

  urlFor(document: TextDocument): string {
    if (!this.workspaceRoot || !this.proxyPort) throw new Error('VitePress preview server is not ready.')
    const relative = path.relative(this.workspaceRoot, document.uri.fsPath).replace(/\\/g, '/')
    const withoutExtension = relative.replace(/\.md$/i, '')
    const route = withoutExtension.split('/').map((segment) => encodeURIComponent(segment)).join('/')
    return `http://127.0.0.1:${this.proxyPort}/${route}`
  }

  document(url: string, cspSource: string): string {
    return webviewDocument(url, cspSource)
  }

  async disposeAsync(): Promise<void> {
    if (this.starting) {
      try { await this.starting } catch { /* continue cleanup */ }
    }
    const proxyServer = this.proxyServer
    this.proxyServer = undefined
    this.proxyPort = undefined
    this.workspaceRoot = undefined
    this.vitePort = undefined
    if (proxyServer) await new Promise<void>((resolve) => proxyServer.close(() => resolve()))
    const viteProcess = this.viteProcess
    this.viteProcess = undefined
    if (viteProcess && !viteProcess.killed) {
      viteProcess.kill()
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_000)
        viteProcess.once('exit', () => { clearTimeout(timer); resolve() })
      })
    }
  }

  dispose(): void {
    void this.disposeAsync()
  }
}
