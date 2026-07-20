export interface MemberProfile {
  id?: string
  name: string
  avatar?: string
  title?: string
  desc?: string
  description?: string
  links?: Array<{ icon?: string; link: string }>
}
