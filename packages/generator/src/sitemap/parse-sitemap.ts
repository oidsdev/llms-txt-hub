export interface SitemapDocument {
  kind: 'index' | 'urlset'
  locs: string[]
}

const LOC_PATTERN = /<loc>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]+?))\s*<\/loc>/gi

/**
 * Read sitemap URLs from an XML document.
 * @param xml - Sitemap or sitemap index body.
 * @returns The document kind and the loc values in order.
 */
export function parseSitemap(xml: string): SitemapDocument {
  const kind = /<sitemapindex[\s>]/i.test(xml) ? 'index' : 'urlset'
  const locs: string[] = []

  for (const match of xml.matchAll(LOC_PATTERN)) {
    const raw = match[1] ?? match[2]
    if (!raw) continue
    const loc = decodeXml(raw.trim())
    if (loc) locs.push(loc)
  }

  return { kind, locs }
}

/**
 * Decode the XML entities used in sitemap loc values.
 * @param value - Raw loc text.
 * @returns Decoded text.
 */
function decodeXml(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, entity => decodeEntity(entity))
}

/**
 * Decode one XML entity.
 * @param entity - Entity including the leading ampersand and trailing semicolon.
 * @returns The decoded character, or the original entity when it is unknown.
 */
function decodeEntity(entity: string): string {
  const named: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&apos;': "'"
  }
  const known = named[entity.toLowerCase()]
  if (known) return known

  const hex = entity.match(/^&#x([0-9a-f]+);$/i)
  if (hex?.[1]) return codePoint(Number.parseInt(hex[1], 16))
  const decimal = entity.match(/^&#(\d+);$/)
  if (decimal?.[1]) return codePoint(Number.parseInt(decimal[1], 10))
  return entity
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
