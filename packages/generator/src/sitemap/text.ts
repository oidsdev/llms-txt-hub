/**
 * Collapse whitespace and trim to a maximum length on a word boundary.
 * @param value - Raw text.
 * @param max - Maximum characters to keep.
 * @returns A single line.
 */
export function oneLine(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= max) return collapsed
  const sliced = collapsed.slice(0, max)
  const cut = sliced.lastIndexOf(' ')
  const trimmed = cut > max * 0.6 ? sliced.slice(0, cut) : sliced
  return trimmed.trim()
}

/**
 * Turn a URL path segment into a short heading.
 * @param segment - One path segment.
 * @returns A heading with spaces instead of hyphens.
 */
export function humanize(segment: string): string {
  let decoded = segment
  try {
    decoded = decodeURIComponent(segment)
  } catch {
    decoded = segment
  }
  const words = decoded.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!words) return 'Pages'
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * Build a title from the last path segment.
 * @param url - Absolute page URL.
 * @returns A short fallback title.
 */
export function fallbackTitle(url: string): string {
  const parts = new URL(url).pathname.split('/').filter(Boolean)
  const last = parts[parts.length - 1]
  if (!last) return url
  return humanize(last)
}
