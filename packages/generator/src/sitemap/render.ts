import { MAX_DESCRIPTION_LENGTH, MAX_TITLE_LENGTH } from './limits'
import { humanize, oneLine } from './text'

export interface DraftPage {
  url: string
  title: string
  description: string
}

export interface DraftInput {
  title: string
  summary: string
  note: string
  pages: DraftPage[]
}

/**
 * Render a draft llms.txt file.
 * @param input - Site heading, summary, draft note, and pages.
 * @returns Markdown with an H1, a blockquote, and H2 sections.
 */
export function renderLlmsTxt(input: DraftInput): string {
  const lines = [
    `# ${oneLine(input.title, MAX_TITLE_LENGTH).replace(/^#+\s*/, '')}`,
    '',
    `> ${oneLine(input.summary.replace(/^>\s*/, ''), MAX_DESCRIPTION_LENGTH)}`,
    '',
    oneLine(input.note, 2000),
    ''
  ]

  for (const [section, pages] of groupBySection(input.pages)) {
    lines.push(`## ${oneLine(section, 80)}`, '')
    for (const page of pages) lines.push(linkLine(page))
    lines.push('')
  }

  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * Group pages by their first path segment, in first-seen order.
 * @param pages - Pages in sitemap order.
 * @returns Section name mapped to its pages.
 */
function groupBySection(pages: DraftPage[]): Map<string, DraftPage[]> {
  const groups = new Map<string, DraftPage[]>()
  for (const page of pages) {
    const name = sectionName(page.url)
    const list = groups.get(name)
    if (list) list.push(page)
    else groups.set(name, [page])
  }
  return groups
}

/**
 * Name the H2 for a page URL.
 * @param url - Absolute page URL.
 * @returns Home, or a heading from the first path segment.
 */
function sectionName(url: string): string {
  const path = new URL(url).pathname
  if (path === '/' || path === '/index.html' || path === '/index.htm') return 'Home'
  const segment = path.split('/').filter(Boolean)[0]
  if (!segment) return 'Home'
  return humanize(segment)
}

/**
 * Render one markdown link, with a description when we have one.
 * @param page - Page title, URL, and description.
 * @returns A single list item.
 */
function linkLine(page: DraftPage): string {
  const title = oneLine(page.title, MAX_TITLE_LENGTH).replace(/[[\]]/g, '')
  const label = title || page.url.replace(/[[\]]/g, '')
  const href = page.url.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29')
  const description = oneLine(page.description, MAX_DESCRIPTION_LENGTH)
  if (!description) return `- [${label}](${href})`
  return `- [${label}](${href}): ${description}`
}
