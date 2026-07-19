import * as vscode from 'vscode'
import { Member } from './preview/parser'
import { isWikiDocument } from './workspace'

const COMMANDS: Array<[string, string]> = [
  ['author', '<AuthorCard author="${1:Lucky}" />'],
  ['version', 'Version<Badge type="tip" text="${1:1.0.0}" />'],
  ['file', 'File<Badge type="info" text="${1:filename}" />'],
  ['code', '```text\n${1}\n```']
]

function rank(member: Member, query: string): number {
  const value = query.toLocaleLowerCase()
  const name = member.name.toLocaleLowerCase()
  if (name === value) return 0
  if (name.startsWith(value)) return 1
  if (name.includes(value)) return 2
  if ([member.title, member.description].some((field) => field?.toLocaleLowerCase().includes(value))) return 3
  return 4
}

export class PyroCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly members: () => Record<string, Member>) {}

  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
    if (!isWikiDocument(document)) return []
    const line = document.lineAt(position.line).text.slice(0, position.character)
    const authorMatch = /(?:\/author[=:]|<AuthorCard\s+author=")([^\s"=:/]*)$/i.exec(line)
    if (authorMatch) {
      const query = authorMatch[1]
      const start = position.character - query.length
      const range = new vscode.Range(position.line, start, position.line, position.character)
      return Object.values(this.members())
        .filter((member) => !query || rank(member, query) < 4)
        .sort((a, b) => rank(a, query) - rank(b, query) || a.name.localeCompare(b.name))
        .map((member) => {
          const item = new vscode.CompletionItem(member.name, vscode.CompletionItemKind.Reference)
          item.detail = member.title ?? 'PYRo Wiki author'
          item.range = range
          item.insertText = member.name
          return item
        })
    }
    const commandMatch = /\/([a-z]*)$/i.exec(line)
    if (!commandMatch) return []
    const query = commandMatch[1].toLocaleLowerCase()
    const start = position.character - commandMatch[0].length
    const range = new vscode.Range(position.line, start, position.line, position.character)
    return COMMANDS.filter(([command]) => command.startsWith(query)).map(([command, snippet]) => {
      const item = new vscode.CompletionItem(`/${command}`, vscode.CompletionItemKind.Keyword)
      item.detail = 'PYRo Wiki snippet'
      item.range = range
      item.insertText = new vscode.SnippetString(snippet)
      return item
    })
  }
}
