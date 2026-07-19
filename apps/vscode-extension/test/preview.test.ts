import { describe, expect, it } from 'vitest'
import MarkdownIt from 'markdown-it'
import { installPyroWikiMarkdownIt, parseStaticMembers, previewDocument, renderMarkdown } from '../src/preview/parser'

const membersSource = `export const mem1 = { avatar: 'https://example.com/a.png', name: 'Lucky', title: 'Lead', desc: 'Robot', links: [{ icon: 'github', link: 'https://github.com/lucky' }] }\nexport const mem2 = { name: 'MekCraftLi', title: 'Engineer' }`

describe('safe preview parser', () => {
  it('renders supported components and static member arrays', () => {
    const members = parseStaticMembers(membersSource)
    const html = renderMarkdown(`<script setup>\nimport { mem1, mem2 } from '../../../public/member_list/members'\nconst core = [mem1, mem2]\n</script>\n# Preview\n\nVersion<Badge type="tip" text="1.0.0"/>\n\nFile<Badge type="info" text="a.h"/><Badge type="info" text="b.cpp"/>\n\n<VPTeamMembers size="small" :members="[mem1, mem2]" />\n\n<AuthorCard author="Lucky" />`, { members })
    expect(html).toContain('1.0.0')
    expect(html).toContain('a.h')
    expect(html).toContain('Lucky')
    expect(html).toContain('MekCraftLi')
    expect(html).not.toContain('script setup')
  })

  it('accepts VitePress spacing and renders the exact Wiki component syntax', () => {
    const members = parseStaticMembers(membersSource)
    const html = renderMarkdown(`Version<Badge type =\"tip\" text=\"1.0.0\"/>\nFile<Badge type = \"info\" text=\"pyro_mutex.h\"/><Badge type = \"info\" text=\"pyro_mutex.cpp\"/>\n\n<script setup>\nimport { mem1 } from '../../../public/member_list/members'\n</script>\n<VPTeamMembers size=\"small\" :members=\"[mem1]\" />`, { members })
    expect(html).toContain('pyro_mutex.h')
    expect(html).toContain('pyro_mutex.cpp')
    expect(html).toContain('Lucky')
    expect(html).toContain('pyro-team-members')
  })

  it('works as a VS Code native Markdown-it plugin', () => {
    const members = parseStaticMembers(membersSource)
    const md = new (MarkdownIt as any)({ html: true })
    installPyroWikiMarkdownIt(md, () => members)
    const html = md.render(`Version<Badge type ="tip" text="1.0.0"/>\n<script setup>\nimport { mem1 } from '../../../public/member_list/members'\n</script>\n<VPTeamMembers size="small" :members="[mem1]" />`)
    expect(html).toContain('pyro-badge-tip')
    expect(html).toContain('Lucky')
    expect(html).toContain('pyro-team-members')
  })

  it('resolves a static array variable used by VPTeamMembers', () => {
    const members = parseStaticMembers(membersSource)
    const html = renderMarkdown(`<script setup>\nimport { mem2 } from '../../../public/member_list/members'\nconst author = [\n  mem2,\n]\n</script>\n<VPTeamMembers size="small" :members="author" />`, { members })
    expect(html).toContain('MekCraftLi')
    expect(html).not.toContain('Lucky')
  })

  it('does not render components inside fenced code or execute setup content', () => {
    const html = renderMarkdown(`<script setup>throw new Error('must not execute')</script>\n\n\`\`\`vue\n<Badge type="tip" text="not-rendered"/>\n<AuthorCard author="not-rendered"/>\n\`\`\``)
    expect(html).toContain('&lt;Badge')
    expect(html).toContain('not-rendered')
    expect(html).not.toContain('pyro-badge')
  })

  it('reports unknown and invalid components', () => {
    const html = renderMarkdown('<UnknownThing />\n<Badge />')
    expect(html).toContain('Unsupported component')
    expect(html).toContain('Badge requires a static text')
  })

  it('escapes component attributes', () => {
    const html = renderMarkdown('<Badge type="tip" text="&lt;script&gt;" />')
    expect(html).not.toContain('<script>')
  })
})

describe('preview document shell', () => {
  it('contains dark theme, a restrictive CSP, and bidirectional scroll hooks', () => {
    const html = previewDocument('# title', { theme: 'dark' })
    expect(html).toContain('<html class=" dark">')
    expect(html).toContain("default-src 'none'")
    expect(html).toContain('previewScroll')
    expect(html).toContain('sourceScroll')
    expect(html).toContain('script-src')
  })
})
