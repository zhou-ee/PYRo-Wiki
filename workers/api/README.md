# PYRo Wiki development API

This Worker is a non-production development API. OAuth is intentionally not enabled yet; the Wrangler configuration sets `PYRO_AUTH_MODE=none` and must not be used for production.

The Worker uses D1 for document/revision metadata and Durable Objects with Yjs for per-document WebSocket collaboration rooms.
