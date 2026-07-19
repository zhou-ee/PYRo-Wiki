const baseUrl = (process.env.PYRO_WIKI_API_BASE_URL ?? 'https://pyro-wiki-api.luckyy.ccwu.cc').replace(/\/$/, '')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function main() {
  const health = await fetch(`${baseUrl}/health`)
  assert(health.status === 200, `health expected 200, got ${health.status}`)
  const healthBody = await health.json()
  assert(healthBody.ok === true, 'health response is not ok')
  assert(healthBody.environment === 'production', `expected production environment, got ${healthBody.environment}`)
  assert(healthBody.authMode === 'feishu', `expected feishu auth mode, got ${healthBody.authMode}`)

  const documents = await fetch(`${baseUrl}/documents?workspace=smoke-test`)
  assert(documents.status === 401, `unauthenticated documents expected 401, got ${documents.status}`)

  const collaboration = await fetch(`${baseUrl}/collaboration/smoke.md?workspace=smoke-test`)
  assert(collaboration.status === 401, `unauthenticated collaboration expected 401, got ${collaboration.status}`)

  const oauth = await fetch(`${baseUrl}/auth/feishu/start`, { redirect: 'manual' })
  assert(oauth.status === 302, `oauth start expected 302, got ${oauth.status}`)
  const location = oauth.headers.get('location')
  assert(location, 'oauth start did not include a location header')
  const authorize = new URL(location)
  assert(authorize.hostname === 'open.feishu.cn', `oauth host is ${authorize.hostname}`)
  assert(authorize.pathname === '/open-apis/authen/v1/authorize', `oauth path is ${authorize.pathname}`)
  assert(authorize.searchParams.get('redirect_uri') === `${baseUrl}/auth/feishu/callback`, 'oauth redirect_uri does not match production callback')
  assert(authorize.searchParams.has('state'), 'oauth state is missing')

  console.log(`PYRo Wiki production smoke passed: ${baseUrl}`)
}

main().catch((error) => {
  console.error(`PYRo Wiki production smoke failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
