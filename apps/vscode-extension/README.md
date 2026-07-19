# PYRo Wiki VS Code extension

This extension provides a safe Markdown preview for PYRo Wiki documents, slash-command snippets, author completion, optional Worker synchronization, and Yjs collaboration.

## Development

```powershell
npm install
npm run typecheck
npm test
npm run package
```

The preview never executes Markdown `script setup` or arbitrary JavaScript. Components are rendered through an explicit allowlist.
