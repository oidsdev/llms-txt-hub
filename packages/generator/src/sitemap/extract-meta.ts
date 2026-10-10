export interface PageMeta {
  title: string
  description: string
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  hellip: '...',
  ldquo: '"',
  lt: '<',
  mdash: '-',
  nbsp: ' ',
  ndash: '-',
  quot: '"',
  rdquo: '"',
  rsquo: "'",
  lsquo: "'"
}

/**
 * Read the document title and meta description from an HTML page.
 * @param html - Raw HTML.
 * @returns Title and description. Either may be empty.
 */
export function extractPageMeta(html: string): PageMeta {
  const source = stripNoise(html)
  const title = firstNonEmpty([
    extractTitle(source),
    metaContent(source, attrs => attribute(attrs, 'property') === 'og:title'),
    metaContent(source, attrs => attribute(attrs, 'name') === 'twitter:title')
  ])
  const description = firstNonEmpty([
    metaContent(source, attrs => attribute(attrs, 'name') === 'description'),
    metaContent(source, attrs => attribute(attrs, 'property') === 'og:description'),
    metaContent(source, attrs => attribute(attrs, 'name') === 'twitter:description')
  ])
  return { title, description }
}

/**
 * Drop comments, scripts, and styles before reading tags.
 * @param html - Raw HTML.
 * @returns HTML with those blocks removed.
 */
function stripNoise(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
}

/**
 * Read the first title element.
 * @param html - HTML with noise removed.
 * @returns Decoded title text, or an empty string.
 */
function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!match?.[1]) return ''
  return decodeHtml(match[1].replace(/<[^>]+>/g, '')).trim()
}

/**
 * Read the first meta content that matches a predicate.
 * @param html - HTML with noise removed.
 * @param matches - Test for the meta attributes.
 * @returns Decoded content, or an empty string.
 */
function metaContent(html: string, matches: (attrs: Map<string, string>) => boolean): string {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? []
  for (const tag of tags) {
    const attrs = readAttributes(tag)
    if (!matches(attrs)) continue
    const content = attrs.get('content')
    if (content) return decodeHtml(content).trim()
  }
  return ''
}

/**
 * Read one attribute in lowercase.
 * @param attrs - Meta attributes.
 * @param key - Attribute name.
 * @returns The lowercase value, or an empty string.
 */
function attribute(attrs: Map<string, string>, key: string): string {
  return (attrs.get(key) ?? '').toLowerCase()
}

/**
 * Return the first string that still has text after trimming.
 * @param values - Candidates in preference order.
 * @returns The first usable string, or an empty string.
 */
function firstNonEmpty(values: string[]): string {
  for (const value of values) {
    if (value.trim()) return value
  }
  return ''
}

/**
 * Read attributes from a single tag.
 * @param tag - A start tag.
 * @returns Lowercase attribute names mapped to raw values.
 */
function readAttributes(tag: string): Map<string, string> {
  const attrs = new Map<string, string>()
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  for (const match of tag.matchAll(pattern)) {
    const name = match[1]?.toLowerCase()
    if (!name || name === 'meta') continue
    if (attrs.has(name)) continue
    attrs.set(name, match[2] ?? match[3] ?? match[4] ?? '')
  }
  return attrs
}

/**
 * Decode common HTML entities.
 * @param value - Raw attribute or element text.
 * @returns Decoded text.
 */
function decodeHtml(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, entity => decodeEntity(entity))
}

/**
 * Decode one HTML entity.
 * @param entity - Entity including the leading ampersand and trailing semicolon.
 * @returns The decoded text, or the original entity when it is unknown.
 */
function decodeEntity(entity: string): string {
  const body = entity.slice(1, -1)
  const hex = body.match(/^#x([0-9a-f]+)$/i)
  if (hex?.[1]) return codePoint(Number.parseInt(hex[1], 16))
  const decimal = body.match(/^#(\d+)$/)
  if (decimal?.[1]) return codePoint(Number.parseInt(decimal[1], 10))
  return NAMED_ENTITIES[body.toLowerCase()] ?? entity
}

/**
 * Turn a code point into a character, or drop it when it is out of range.
 * @param value - Unicode code point.
 * @returns The character, or an empty string.
 */
function codePoint(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return ''
  return String.fromCodePoint(value)
}
