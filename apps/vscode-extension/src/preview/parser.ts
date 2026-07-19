export interface Member {
  id: string
  name: string
  avatar?: string
  title?: string
  description?: string
  links?: Array<{ icon?: string; link: string }>
}

export interface PreviewOptions {
  members?: Record<string, Member>
  theme?: 'light' | 'dark'
  documentUri?: string
}

const COMPONENT_MARKER = '@@PYRO_COMPONENT_'

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character] ?? character)
}

function splitProtected(markdown: string): string[] {
  const parts: string[] = []
  let cursor = 0
  const fence = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g
  let match: RegExpExecArray | null
  while ((match = fence.exec(markdown))) {
    if (match.index > cursor) parts.push(markdown.slice(cursor, match.index))
    parts.push(match[0])
    cursor = match.index + match[0].length
  }
  if (cursor < markdown.length) parts.push(markdown.slice(cursor))
  return parts.length ? parts : ['']
}

function parseAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  const expressionAttributes: Record<string, string> = {}
  const pattern = /(?:^|\s)(:?[-\w]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(raw))) {
    const key = match[1]
    const value = match[2] ?? match[3] ?? match[4] ?? ''
    if (key.startsWith(':')) expressionAttributes[key.slice(1)] = value
    else attributes[key] = value
  }
  return { ...attributes, ...Object.fromEntries(Object.entries(expressionAttributes).map(([key, value]) => [`:${key}`, value])) }
}

function field(objectText: string, key: string): string | undefined {
  const pattern = new RegExp(`(?:^|[,\\n])\\s*${key}\\s*:\\s*([\\\"'])([\\s\\S]*?)\\1`)
  return pattern.exec(objectText)?.[2]
}

function findObjectEnd(source: string, start: number): number {
  let depth = 0
  let quote = ''
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = ''
      continue
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character
      continue
    }
    if (character === '{') depth += 1
    else if (character === '}' && --depth === 0) return index
  }
  return -1
}

export function parseStaticMembers(source: string): Record<string, Member> {
  const members: Record<string, Member> = {}
  const declarationPattern = /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g
  let match: RegExpExecArray | null
  while ((match = declarationPattern.exec(source))) {
    const objectStart = declarationPattern.lastIndex - 1
    const objectEnd = findObjectEnd(source, objectStart)
    if (objectEnd < 0) continue
    const id = match[1]
    const body = source.slice(objectStart + 1, objectEnd)
    const name = field(body, 'name')
    if (!name) continue
    const linksBody = /links\s*:\s*\[([\s\S]*?)\]/.exec(body)?.[1] ?? ''
    const links = [...linksBody.matchAll(/(?:icon\s*:\s*['"]([^'"]+)['"]\s*,?\s*)?link\s*:\s*['"]([^'"]+)['"]/g)]
      .map((link) => ({ icon: link[1], link: link[2] }))
    members[id] = {
      id,
      name,
      avatar: field(body, 'avatar'),
      title: field(body, 'title'),
      description: field(body, 'desc') ?? field(body, 'description'),
      links
    }
    declarationPattern.lastIndex = objectEnd + 1
  }
  return members
}

function parseSetup(setup: string): { aliases: Record<string, string>; arrays: Record<string, string[]> } {
  const aliases: Record<string, string> = {}
  const arrays: Record<string, string[]> = {}
  for (const match of setup.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*['"][^'"]*member_list\/members[^'"]*['"]/g)) {
    for (const name of match[1].split(',').map((item) => item.trim()).filter(Boolean)) {
      const [original, alias] = name.split(/\s+as\s+/)
      aliases[(alias ?? original).trim()] = original.trim()
    }
  }
  for (const match of setup.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*\[([^\]]*)\]/g)) {
    arrays[match[1]] = match[2].split(',').map((item) => item.trim()).filter(Boolean)
  }
  return { aliases, arrays }
}

function card(member: Member): string {
  const avatar = member.avatar ? `<img class="pyro-member-avatar" src="${escapeHtml(member.avatar)}" alt="${escapeHtml(member.name)}" />` : '<div class="pyro-member-avatar pyro-member-avatar-placeholder"></div>'
  const links = (member.links ?? []).map((link) => `<a href="${escapeHtml(link.link)}" target="_blank" rel="noreferrer">${escapeHtml(link.icon ?? 'link')}</a>`).join(' ')
  return `<article class="pyro-member-card">${avatar}<div><strong>${escapeHtml(member.name)}</strong>${member.title ? `<div class="pyro-member-title">${escapeHtml(member.title)}</div>` : ''}${member.description ? `<p>${escapeHtml(member.description)}</p>` : ''}${links ? `<div class="pyro-member-links">${links}</div>` : ''}</div></article>`
}

function renderComponent(name: string, rawAttributes: string, members: Record<string, Member>, setup: { aliases: Record<string, string>; arrays: Record<string, string[]> }): string | null {
  const attrs = parseAttributes(rawAttributes)
  if (name === 'Badge') {
    const type = attrs.type ?? 'tip'
    const text = attrs.text
    if (!text) return `<div class="pyro-preview-error">Badge requires a static text attribute</div>`
    return `<span class="pyro-badge pyro-badge-${escapeHtml(type)}">${escapeHtml(text)}</span>`
  }
  if (name === 'AuthorCard') {
    const author = attrs.author
    if (!author) return `<div class="pyro-preview-error">AuthorCard requires a static author attribute</div>`
    const member = Object.values(members).find((item) => item.name === author || item.id === author)
    return member ? `<div class="pyro-author-card">${card(member)}</div>` : `<div class="pyro-preview-error">Unknown author: ${escapeHtml(author)}</div>`
  }
  if (name === 'VPTeamMembers') {
    const expression = attrs[':members'] ?? ''
    const names = expression.match(/\[([^\]]*)\]/)?.[1]?.split(',').map((item) => item.trim()).filter(Boolean)
      ?? setup.arrays[expression]?.flatMap((item) => item.split(',').map((value) => value.trim()).filter(Boolean))
      ?? Object.keys(members)
    const resolved = names.map((name) => members[setup.aliases[name] ?? name] ?? members[name]).filter(Boolean)
    if (!resolved.length) return '<div class="pyro-preview-error">VPTeamMembers has no resolvable static members</div>'
    return `<section class="pyro-team-members">${resolved.map(card).join('')}</section>`
  }
  if (name === 'VPTeamPage' || name === 'VPTeamPageTitle' || name === 'VPTeamPageSection' || name === 'RecentUpdates') return null
  if (name === 'template') return null
  return `<div class="pyro-preview-error">Unsupported component: ${escapeHtml(name)}</div>`
}

function transformSegment(segment: string, members: Record<string, Member>, setup: { aliases: Record<string, string>; arrays: Record<string, string[]> }, markers: Map<string, string>): string {
  const withoutSetup = segment.replace(/<script\s+setup(?:\s+[^>]*)?>[\s\S]*?<\/script>/gi, '')
  const tagPattern = /<([A-Z][A-Za-z0-9]+|template)\b([^>]*?)(?:\/>|>(?:<\/\1>)?)/g
  return withoutSetup.replace(tagPattern, (_full, name: string, attributes: string) => {
    const html = renderComponent(name, attributes, members, setup)
    if (html === null) return ''
    const marker = `${COMPONENT_MARKER}${markers.size}@@`
    markers.set(marker, html)
    return marker
  })
}

function transformComponents(markdown: string, members: Record<string, Member>): { transformed: string; markers: Map<string, string> } {
  const setupText = [...markdown.matchAll(/<script\s+setup(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi)].map((match) => match[1]).join('\n')
  const setup = parseSetup(setupText)
  const markers = new Map<string, string>()
  const transformed = splitProtected(markdown).map((segment) => segment.startsWith('```') || segment.startsWith('~~~') ? segment : transformSegment(segment, members, setup, markers)).join('')
  return { transformed, markers }
}

export function preprocessComponents(markdown: string, members: Record<string, Member> = {}): string {
  const { transformed, markers } = transformComponents(markdown, members)
  let result = transformed
  for (const [marker, value] of markers) result = result.split(marker).join(value)
  return result
}

export function installPyroWikiMarkdownIt(md: any, getMembers: () => Record<string, Member>): any {
  md.core.ruler.before('block', 'pyro-wiki-components', (state: any) => {
    state.src = preprocessComponents(state.src, getMembers())
  })
  return md
}

export function renderMarkdown(markdown: string, options: PreviewOptions = {}): string {
  const { transformed, markers } = transformComponents(markdown, options.members ?? {})
  const MarkdownIt = require('markdown-it') as typeof import('markdown-it')
  const md = new (MarkdownIt as any)({ html: false, linkify: true, typographer: true })
  let html = md.render(transformed)
  for (const [marker, value] of markers) html = html.split(marker).join(value)
  return html
}

export function previewDocument(markdown: string, options: PreviewOptions = {}): string {
  const body = renderMarkdown(markdown, options)
  const dark = options.theme === 'dark' ? ' dark' : ''
  const nonce = Math.random().toString(36).slice(2)
  const script = `const vscode=acquireVsCodeApi();let programmatic=false;const scrolling=()=>document.scrollingElement||document.documentElement;const ratio=()=>{const element=scrolling();const max=Math.max(1,element.scrollHeight-window.innerHeight);return Math.max(0,Math.min(1,element.scrollTop/max))};window.addEventListener('scroll',()=>{if(!programmatic)vscode.postMessage({type:'previewScroll',ratio:ratio()})},{passive:true});window.addEventListener('message',event=>{if(event.data?.type==='sourceScroll'){programmatic=true;const element=scrolling();const max=Math.max(1,element.scrollHeight-window.innerHeight);element.scrollTop=Math.max(0,Math.min(1,event.data.ratio))*max;window.setTimeout(()=>{programmatic=false},180)}});window.addEventListener('load',()=>vscode.postMessage({type:'previewReady'}));`
  return `<!doctype html><html class="${dark}"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><style>${previewStyles()}</style></head><body><main class="pyro-preview">${body}</main><script nonce="${nonce}">${script}</script></body></html>`
}

function previewStyles(): string {
  return `:root{color-scheme:light;background:#fff;color:#213547;font-family:var(--vscode-font-family,Inter,system-ui,sans-serif)}html.dark{color-scheme:dark;background:#1b1b1f;color:#ddd}body{margin:0;padding:24px 64px 176px 32px}.pyro-preview{max-width:900px;margin:auto;line-height:1.7}.pyro-badge{display:inline-block;border-radius:8px;padding:0 8px;font-size:.8em;line-height:1.6;margin:0 3px;border:1px solid transparent}.pyro-badge-tip{color:#3451b2;background:#e8edff;border-color:#b7c4ff}.pyro-badge-info{color:#18794e;background:#e6f6ed;border-color:#a6dfbd}.dark .pyro-badge-tip{color:#c4d0ff;background:#27315f}.dark .pyro-badge-info{color:#a6e3bc;background:#173b28}.pyro-team-members{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin:20px 0}.pyro-member-card,.pyro-author-card{display:flex;gap:14px;align-items:flex-start;padding:16px;border:1px solid #e2e2e3;border-radius:12px;background:#fff;box-shadow:0 2px 8px #0000000d}.dark .pyro-member-card,.dark .pyro-author-card{border-color:#3b3b43;background:#242429}.pyro-member-avatar{width:52px;height:52px;border-radius:50%;object-fit:cover;flex:0 0 auto;background:#ddd}.pyro-member-avatar-placeholder{background:linear-gradient(135deg,#42d392,#647eff)}.pyro-member-title,.pyro-member-card p{font-size:.86em;color:#777;margin:2px 0}.dark .pyro-member-title,.dark .pyro-member-card p{color:#aaa}.pyro-member-links{font-size:.8em;display:flex;gap:8px}.pyro-preview-error{color:#b42318;background:#fff1f0;border:1px solid #f5b5af;border-radius:6px;padding:8px;margin:8px 0}.dark .pyro-preview-error{color:#ffb4ab;background:#4c1d1a;border-color:#8c3028}pre{overflow:auto;padding:14px;border-radius:8px;background:#f6f6f7}.dark pre{background:#26262c}code{font-family:var(--vscode-editor-font-family,ui-monospace,monospace)}`
}
