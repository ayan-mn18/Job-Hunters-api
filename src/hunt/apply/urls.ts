/**
 * Application forms expect a plain absolute URL. Models and copied profile
 * data sometimes supply a Markdown link instead, or omit the scheme; accepting
 * those small variations here keeps a malformed value from breaking a run.
 */
export function normaliseHttpUrl(value: string): string {
  const raw = value.trim()
  if (!raw) return ''

  // Accept `[label](https://example.com)` as a convenience, but never pass
  // Markdown itself into a browser form or page navigation.
  const markdown = /^\[[^\]]*\]\((https?:\/\/[^)\s]+)\)$/i.exec(raw)
  const candidate = (markdown?.[1] ?? raw).replace(/^<|>$/g, '')
  const absolute = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`

  try {
    const parsed = new URL(absolute)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return candidate
    return parsed.toString().replace(/\/$/, parsed.pathname === '/' ? '/' : '')
  } catch {
    // Keep the original value so the caller can report it or let the bounded
    // agent recovery explain how to repair it; do not invent a destination.
    return candidate
  }
}
