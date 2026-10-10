import type { RequestContext } from './http'
import { requestText } from './http'
import { parseSitemap } from './parse-sitemap'
import { isPathAllowed, type RobotsGroup } from './robots'

const SKIPPED_EXTENSIONS = new Set([
  'atom',
  'css',
  'eot',
  'gif',
  'gz',
  'ico',
  'jpeg',
  'jpg',
  'js',
  'json',
  'mjs',
  'mp3',
  'mp4',
  'pdf',
  'png',
  'rss',
  'svg',
  'ttf',
  'txt',
  'webm',
  'webp',
  'woff',
  'woff2',
  'xml',
  'zip'
])

export interface CollectResult {
  urls: string[]
  warnings: string[]
}

interface CollectState {
  urls: string[]
  warnings: string[]
  seen: Set<string>
  truncated: boolean
  disallowed: number
  offHost: number
  files: number
}

/**
 * Collect same-host page URLs from a sitemap or one level of sitemap index.
 * @param xml - Root sitemap body.
 * @param group - Robots group for this crawler.
 * @param maxPages - Maximum page URLs to return.
 * @param context - HTTP context used for child sitemaps.
 * @returns Page URLs in sitemap order, plus warnings.
 */
export async function collectPageUrls(
  xml: string,
  group: RobotsGroup | undefined,
  maxPages: number,
  context: RequestContext
): Promise<CollectResult> {
  const state = emptyState()
  const doc = parseSitemap(xml)
  if (doc.kind === 'index') await takeIndex(doc.locs, state, group, maxPages, context)
  else takeLocs(doc.locs, state, group, maxPages, context.host)
  return finish(state, maxPages)
}

/**
 * Fetch child sitemaps until enough page URLs are collected.
 * @param locs - Child sitemap URLs.
 * @param state - Collection counters.
 * @param group - Robots group for this crawler.
 * @param maxPages - Maximum page URLs to return.
 * @param context - HTTP context.
 */
async function takeIndex(
  locs: string[],
  state: CollectState,
  group: RobotsGroup | undefined,
  maxPages: number,
  context: RequestContext
): Promise<void> {
  for (const loc of locs) {
    if (state.truncated) return
    const child = acceptChild(loc, state, group, context.host)
    if (!child) continue
    const response = await requestText(child, context)
    if (!response.ok || response.status < 200 || response.status >= 300) {
      state.warnings.push(`Could not read sitemap ${child}.`)
      continue
    }
    const nested = parseSitemap(response.body)
    if (nested.kind === 'index') {
      state.warnings.push(`Skipped nested sitemap index ${child}.`)
      continue
    }
    takeLocs(nested.locs, state, group, maxPages, context.host)
  }
}

/**
 * Add page URLs from one urlset until the cap is reached.
 * @param locs - Page URLs.
 * @param state - Collection counters.
 * @param group - Robots group for this crawler.
 * @param maxPages - Maximum page URLs to return.
 * @param host - Sitemap host.
 */
function takeLocs(
  locs: string[],
  state: CollectState,
  group: RobotsGroup | undefined,
  maxPages: number,
  host: string
): void {
  for (const loc of locs) {
    consider(loc, state, group, maxPages, host)
    if (state.truncated) return
  }
}

/**
 * Accept one page URL or record why it was left out.
 * @param loc - Raw loc value.
 * @param state - Collection counters.
 * @param group - Robots group for this crawler.
 * @param maxPages - Maximum page URLs to return.
 * @param host - Sitemap host.
 */
function consider(
  loc: string,
  state: CollectState,
  group: RobotsGroup | undefined,
  maxPages: number,
  host: string
): void {
  const url = parseLoc(loc)
  if (!url) return
  if (url.host !== host) {
    state.offHost += 1
    return
  }
  url.hash = ''
  if (hasSkippedExtension(url.pathname)) {
    state.files += 1
    return
  }
  if (!isPathAllowed(group, url)) {
    state.disallowed += 1
    return
  }
  const normalized = url.toString()
  if (state.seen.has(normalized)) return
  state.seen.add(normalized)
  if (state.urls.length >= maxPages) {
    state.truncated = true
    return
  }
  state.urls.push(normalized)
}

/**
 * Accept a child sitemap URL on this host.
 * @param loc - Raw loc value.
 * @param state - Collection counters.
 * @param group - Robots group for this crawler.
 * @param host - Sitemap host.
 * @returns The absolute URL to fetch, or undefined when it should be skipped.
 */
function acceptChild(
  loc: string,
  state: CollectState,
  group: RobotsGroup | undefined,
  host: string
): string | undefined {
  const url = parseLoc(loc)
  if (!url) return undefined
  if (url.host !== host) {
    state.offHost += 1
    return undefined
  }
  url.hash = ''
  if (!isPathAllowed(group, url)) {
    state.disallowed += 1
    return undefined
  }
  return url.toString()
}

/**
 * Parse a loc when it is an http(s) URL.
 * @param loc - Raw loc value.
 * @returns The URL, or undefined when it cannot be fetched.
 */
function parseLoc(loc: string): URL | undefined {
  try {
    const url = new URL(loc)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url
  } catch {
    return undefined
  }
}

/**
 * Skip URLs that point at common non-HTML files.
 * @param pathname - URL path.
 * @returns True when the extension is not a web page.
 */
function hasSkippedExtension(pathname: string): boolean {
  const path = pathname.toLowerCase()
  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')
  if (dot === -1 || slash > dot) return false
  return SKIPPED_EXTENSIONS.has(path.slice(dot + 1))
}

/**
 * Turn counters into the public result.
 * @param state - Collection counters.
 * @param maxPages - Maximum page URLs requested.
 * @returns Page URLs and warnings.
 */
function finish(state: CollectState, maxPages: number): CollectResult {
  const warnings = [...state.warnings]
  if (state.truncated) {
    warnings.push(
      `Sitemap has more than ${maxPages} allowed pages. The draft includes the first ${maxPages}.`
    )
  }
  if (state.disallowed > 0) {
    warnings.push(`${state.disallowed} sitemap URLs were disallowed by robots.txt.`)
  }
  if (state.offHost > 0) {
    warnings.push(`${state.offHost} sitemap URLs were on another host and were skipped.`)
  }
  if (state.files > 0) {
    warnings.push(`${state.files} sitemap URLs pointed at files and were skipped.`)
  }
  return { urls: state.urls, warnings }
}

/**
 * Create empty collection counters.
 * @returns A fresh state object.
 */
function emptyState(): CollectState {
  return {
    urls: [],
    warnings: [],
    seen: new Set<string>(),
    truncated: false,
    disallowed: 0,
    offHost: 0,
    files: 0
  }
}
