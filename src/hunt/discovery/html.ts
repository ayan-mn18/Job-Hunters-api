/**
 * HTML handling for job descriptions.
 *
 * The old `stripHtml` collapsed a whole posting onto one line. That is fine for
 * a preview and useless for everything else: once `<li>` boundaries are gone
 * there is no way to tell a responsibilities list from a paragraph, which is
 * why nothing downstream could find bullets or section headings. These two
 * functions keep the structure — one as text with real line breaks, one as a
 * small allowlisted subset of markup the UI can render.
 */

const BLOCK_TAGS =
  'address|article|aside|blockquote|br|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul'

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  rsquo: '\u2019',
  lsquo: '\u2018',
  ldquo: '\u201c',
  rdquo: '\u201d',
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  bull: '\u2022',
  middot: '\u00b7',
  eacute: '\u00e9',
  trade: '\u2122',
  reg: '\u00ae',
  copy: '\u00a9',
  euro: '\u20ac',
  pound: '\u00a3',
  deg: '\u00b0',
}

export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, entity: string) => {
    const key = entity.toLowerCase()
    if (key.startsWith('#x')) {
      const code = Number.parseInt(key.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (key.startsWith('#')) {
      const code = Number.parseInt(key.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[key] ?? match
  })
}

function dropInvisible(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
}

/**
 * HTML to plain text, preserving paragraph breaks and turning list items into
 * `• ` bullets so section parsers have something to anchor on.
 */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return ''
  const text = dropInvisible(html)
    .replace(/<li[^>]*>/gi, '\n\u2022 ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/(?:h[1-6])>/gi, '\n\n')
    .replace(new RegExp(`</?(?:${BLOCK_TAGS})[^>]*>`, 'gi'), '\n')
    .replace(/<[^>]+>/g, '')
  return decodeEntities(text)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Single-line text, for previews and keyword matching. */
export function htmlToInlineText(html: string | null | undefined): string {
  return htmlToText(html).replace(/\s+/g, ' ').trim()
}

const ALLOWED_TAGS = new Set([
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code', 'pre', 'a',
])

/**
 * Allowlist sanitiser. Everything not on the list is dropped, all attributes
 * are dropped except `href` on `<a>`, and non-http(s) hrefs go too — this
 * markup is rendered in the dashboard, so a posting must not be able to smuggle
 * a script or a `javascript:` link into it.
 */
export function sanitiseHtml(html: string | null | undefined): string {
  if (!html) return ''
  const cleaned = dropInvisible(html).replace(
    /<(\/?)([a-z][a-z0-9]*)\b([^>]*)>/gi,
    (match, closing: string, tag: string, attributes: string) => {
      const name = tag.toLowerCase()
      if (!ALLOWED_TAGS.has(name)) return ' '
      if (closing) return `</${name}>`
      if (name === 'a') {
        const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes)
        const value = (href?.[1] ?? href?.[2] ?? href?.[3] ?? '').trim()
        if (!/^https?:\/\//i.test(value)) return '<a>'
        return `<a href="${value.replace(/"/g, '&quot;')}" target="_blank" rel="noreferrer nofollow">`
      }
      return `<${name}>`
    },
  )
  return cleaned.replace(/[ \t]+/g, ' ').replace(/(\s*\n\s*){3,}/g, '\n\n').trim()
}

/** Reads a `<meta>` value by `name` or `property`. */
export function metaContent(html: string, key: string): string | undefined {
  const pattern = new RegExp(
    `<meta[^>]+(?:name|property)\\s*=\\s*["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`,
    'i',
  )
  const tag = pattern.exec(html)?.[0]
  if (!tag) return undefined
  const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag)
  const value = content?.[1] ?? content?.[2]
  return value ? decodeEntities(value).trim() : undefined
}
