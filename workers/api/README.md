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
