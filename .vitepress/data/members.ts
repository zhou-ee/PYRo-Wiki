import * as memberData from '../../public/member_list/members'
import type { MemberProfile } from './member-types'

export type { MemberProfile } from './member-types'
export const memberRegistry = memberData as unknown as Record<string, MemberProfile>
export { mem1, mem2, mem3, mem4, mem5, mem6, mem7, mem8, mem9 } from '../../public/member_list/members'
