# PYRo Wiki VS Code extension

This extension provides local VitePress preview, Markdown workspace navigation, Feishu-authenticated cloud document sync, and Yjs collaboration for PYRo Wiki.

## Production cloud API

The default API is:

```text
https://pyro-wiki-api.luckyy.ccwu.cc
```

Override it with `pyroWiki.apiBaseUrl` for local development.

## Feishu login

Use `PYRo Wiki: Sign in with Feishu`. The browser authorization callback is:

```text
https://pyro-wiki-api.luckyy.ccwu.cc/auth/feishu/callback
```

After authorization, the Worker returns a one-time handoff code to the VS Code URI handler. Long-lived refresh tokens are stored in VS Code SecretStorage, not in the repository or Webview URL.

## Cloud documents and collaboration

The PYRo Wiki activity bar includes: local Markdown documents, Cloud Documents, and Collaboration. Cloud Documents loads remote D1-backed revisions after login and shows whether each file is synced, remote-newer, local-newer, not pulled, or missing locally. Use `Pull`, `Push`, `Save Cloud Draft`, `View Cloud Revisions`, and `Compare Cloud Document` from the editor or Cloud Documents view. Collaboration connects the current Wiki Markdown document to the authenticated Durable Object/Yjs room, sends live Yjs updates, keeps editing locally during disconnects, and retries with exponential backoff. If a Push is interrupted by a network failure, use `PYRo Wiki: Retry Sync Queue` after connectivity returns.

## Development

```powershell
npm install
npm run typecheck
npm test
npm run package
# or install the current VSIX into the local VS Code instance
npm run install-local
```

The full preview command starts the Wiki workspace's own VitePress development server.
