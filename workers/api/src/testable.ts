export function normalizePathForTest(value: string): string {
  return decodeURIComponent(value).replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+/g, '/').replace(/(^|\/)\.\.(?=\/|$)/g, '').replace(/^\/+/, '').trim()
}
