import { memberRegistry, type MemberProfile } from '../../../data/members'

export type { MemberProfile }

export function resolveMember(author: string): MemberProfile | undefined {
  return Object.values(memberRegistry).find((candidate) => candidate.name === author || candidate.id === author)
}

export function memberInitials(author: string, member?: MemberProfile): string {
  return (member?.name ?? author).trim().slice(0, 2).toUpperCase()
}
