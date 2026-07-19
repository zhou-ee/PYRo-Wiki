# PYRo Wiki API

The Worker serves authenticated document sync and Yjs collaboration. Development uses `infra/cloudflare/wrangler.api.jsonc`; production uses `infra/cloudflare/wrangler.api.prod.jsonc` and the custom domain `https://pyro-wiki-api.luckyy.ccwu.cc`.

## Production secrets

Configure these only through Wrangler Secret Store; never commit them:

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `AUTH_SESSION_SECRET`
- `FEISHU_TENANT_KEY` (optional internal-tenant restriction)

The Feishu callback URL is:

```text
https://pyro-wiki-api.luckyy.ccwu.cc/auth/feishu/callback
```

The production database must be created and its ID inserted into the production Wrangler config before applying remote migrations.

## Production deployment

```powershell
npx wrangler deploy `
  --config .\infra\cloudflare\wrangler.api.prod.jsonc `
  --domain pyro-wiki-api.luckyy.ccwu.cc
```

The public health endpoint is `GET https://pyro-wiki-api.luckyy.ccwu.cc/health`. Document and collaboration endpoints require a Feishu-backed Bearer access token. WebSocket clients authenticate during the Worker upgrade; tokens are not placed in query parameters.

## Local API integration smoke

From the repository root, run:

```powershell
npm run smoke:local-api
```

This starts the development Worker with local D1 persistence, applies migrations to an isolated `.wrangler/smoke-local` directory, and verifies document creation, pull, revision history, drafts, and stale-revision conflicts.

The local collaboration protocol can be checked with:

```powershell
npm run smoke:local-collaboration
```

This opens two local WebSocket clients and verifies initial Yjs sync, incremental updates, connection-scoped Presence, and offline Presence events.

The local session lifecycle can be checked with:

```powershell
npm run smoke:local-auth
```

It uses only fake local credentials and verifies one-time handoff exchange, `/me`, refresh-token rotation, logout, and session revocation.
