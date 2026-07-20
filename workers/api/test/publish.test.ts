import { describe, expect, it } from 'vitest'
import { isPublisher } from '../src/publishRequests'

describe('publish request permissions', () => {
  it('allows the development anonymous maintainer only outside production', () => {
    const user = { id: 'dev-anonymous', openId: 'dev-anonymous', name: 'Development User' }
    expect(isPublisher({ PYRO_ENVIRONMENT: 'development' }, user)).toBe(true)
    expect(isPublisher({ PYRO_ENVIRONMENT: 'production' }, user)).toBe(false)
  })

  it('matches configured Feishu ids and rejects ordinary users', () => {
    const env = { PYRO_ENVIRONMENT: 'production', PYRO_PUBLISHER_IDS: 'maintainer-id,open-id-2' }
    expect(isPublisher(env, { id: 'maintainer-id', openId: 'other', name: 'Maintainer' })).toBe(true)
    expect(isPublisher(env, { id: 'user-id', openId: 'open-id-2', name: 'Maintainer' })).toBe(true)
    expect(isPublisher(env, { id: 'user-id', openId: 'ordinary-open-id', name: 'User' })).toBe(false)
  })
})
