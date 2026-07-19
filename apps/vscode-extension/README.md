# PYRo Wiki VS Code extension

This extension provides a full VitePress/Vue preview for PYRo Wiki Markdown documents, slash-command snippets, author completion, optional Worker synchronization, and Yjs collaboration.

## Full VitePress preview

The `PYRo Wiki: Open Preview` command starts the VitePress development server from the configured Wiki root and loads the real VitePress page inside the VS Code Webview. This means the preview uses the Wiki's own:

- `.vitepress/config.*`
- custom theme and layout
- Vue components and `script setup`
- VitePress Markdown compiler
- static assets and route resolution

VitePress must be installed in the Wiki workspace, normally through the root `package.json`. The preview saves dirty Markdown files before reloading by default (`pyroWiki.syncUnsavedPreview`) so the VitePress server cannot render an older on-disk copy.

## Development

```powershell
npm install
npm run typecheck
npm test
npm run package
```

The extension keeps the old safe Markdown-it adapter only for VS Code's native Markdown-it integration. The PYRo Wiki preview command itself no longer renders Markdown through the component allowlist.
