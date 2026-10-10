import { collectPageUrls } from './collect'
import { extractPageMeta } from './extract-meta'
import { createRateLimiter, type FetchLike, type RequestContext, requestText } from './http'
import {
  MAX_CRAWL_DELAY_MS,
  MAX_DESCRIPTION_LENGTH,
  MAX_PAGES,
  MAX_TITLE_LENGTH,
  MIN_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  USER_AGENT
} from './limits'
import { renderLlmsTxt } from './render'
import {
  crawlDelayMs,
  isPathAllowed,
  matchingGroup,
  parseRobotsTxt,
  type RobotsGroup
} from './robots'
import { assertPublicUrl, type LookupHost, lookupHost } from './safety'
import { fallbackTitle, oneLine } from './text'

export interface GenerateOptions {
  sitemapUrl: string
  maxPages?: number
  fetch?: FetchLike
  lookup?: LookupHost
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  userAgent?: string
  timeoutMs?: number
}

export interface SkippedPage {
  url: string
  reason: string
}

export interface PageRecord {
  url: string
  title: string
  description: string
}

export interface DraftSuccess {
  ok: true
  markdown: string
  pages: PageRecord[]
  skipped: SkippedPage[]
  warnings: string[]
}

export interface DraftFailure {
  ok: false
  reason: string
  warnings: string[]
}

interface RobotsReady {
  ok: true
  group: RobotsGroup | undefined
  warnings: string[]
}

/**
 * Crawl a sitemap and draft an llms.txt file.
 * @param options - Sitemap URL and optional fetch hooks.
 * @returns The draft, or a reason the crawl stopped.
 */
export async function generateFromSitemap(
  options: GenerateOptions
): Promise<DraftSuccess | DraftFailure> {
  const resolve = options.lookup ?? lookupHost
  const checked = await assertPublicUrl(options.sitemapUrl, resolve)
  if (!checked.ok) return { ok: false, reason: checked.reason, warnings: [] }

  const context: RequestContext = {
    fetch: options.fetch ?? defaultFetch,
    lookup: resolve,
    limiter: createRateLimiter(
      MIN_INTERVAL_MS,
      options.now ?? Date.now,
      options.sleep ?? defaultSleep
    ),
    timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    userAgent: options.userAgent ?? USER_AGENT,
    host: checked.url.host
  }

  const robots = await loadRobots(checked.url.origin, context)
  if (!robots.ok) return robots
  if (!isPathAllowed(robots.group, checked.url)) {
    return { ok: false, reason: 'robots.txt disallows the sitemap URL.', warnings: robots.warnings }
  }

  const sitemap = await requestText(checked.url.toString(), context)
  if (!sitemap.ok) {
    return {
      ok: false,
      reason: `Could not read the sitemap. ${sitemap.reason}`,
      warnings: robots.warnings
    }
  }
  if (sitemap.status < 200 || sitemap.status >= 300) {
    return { ok: false, reason: `Sitemap returned ${sitemap.status}.`, warnings: robots.warnings }
  }

  const maxPages = clampMaxPages(options.maxPages)
  const collected = await collectPageUrls(sitemap.body, robots.group, maxPages, context)
  const loaded = await loadPages(collected.urls, context)
  const warnings = [...robots.warnings, ...collected.warnings]
  if (loaded.pages.length === 0) {
    return { ok: false, reason: 'No pages could be read from the sitemap.', warnings }
  }

  const markdown = renderLlmsTxt({
    title: siteHeading(loaded.pages, checked.url.hostname),
    summary: siteSummary(loaded.pages, checked.url.hostname),
    note: `Draft generated from ${checked.url.toString()}. ${loaded.pages.length} pages. Review before publishing.`,
    pages: loaded.pages
  })

  return { ok: true, markdown, pages: loaded.pages, skipped: loaded.skipped, warnings }
}

/**
 * Fetch robots.txt and apply Crawl-delay before any other URL is read.
 * @param origin - Sitemap origin, including protocol and host.
 * @param context - HTTP context for this crawl.
 * @returns The matching robots group, or a reason the crawl stopped.
 */
async function loadRobots(
  origin: string,
  context: RequestContext
): Promise<RobotsReady | DraftFailure> {
  const response = await requestText(new URL('/robots.txt', origin).toString(), context)
  if (!response.ok) {
    return { ok: false, reason: `Could not read robots.txt. ${response.reason}`, warnings: [] }
  }
  if (response.status >= 500) {
    return {
      ok: false,
      reason: `robots.txt returned ${response.status}. Crawl stopped.`,
      warnings: []
    }
  }
  if (response.status >= 400) return { ok: true, group: undefined, warnings: [] }

  const group = matchingGroup(parseRobotsTxt(response.body), context.userAgent)
  const delay = crawlDelayMs(group)
  const warnings: string[] = []
  if (delay !== undefined && delay > MAX_CRAWL_DELAY_MS) {
    warnings.push(
      `Crawl-delay is ${Math.round(delay / 1000)}s. Waiting ${MAX_CRAWL_DELAY_MS / 1000}s between requests.`
    )
  } else if (delay !== undefined && delay > MIN_INTERVAL_MS) {
    warnings.push(`Crawl-delay is ${Math.round(delay / 1000)}s.`)
  }
  const interval = Math.max(MIN_INTERVAL_MS, Math.min(delay ?? MIN_INTERVAL_MS, MAX_CRAWL_DELAY_MS))
  context.limiter.setIntervalMs(interval)
  return { ok: true, group, warnings }
}

/**
 * Fetch each selected page and keep the ones that return HTML.
 * @param urls - Page URLs in sitemap order.
 * @param context - HTTP context for this crawl.
 * @returns Pages that were read and URLs that were skipped.
 */
async function loadPages(
  urls: string[],
  context: RequestContext
): Promise<{ pages: PageRecord[]; skipped: SkippedPage[] }> {
  const pages: PageRecord[] = []
  const skipped: SkippedPage[] = []
  for (const url of urls) {
    const page = await readPage(url, context)
    if (page.ok) pages.push(page.page)
    else skipped.push({ url, reason: page.reason })
  }
  return { pages, skipped }
}

/**
 * Fetch one page and read its title and description.
 * @param url - Absolute page URL.
 * @param context - HTTP context for this crawl.
 * @returns The page, or a reason it was skipped.
 */
async function readPage(
  url: string,
  context: RequestContext
): Promise<{ ok: true; page: PageRecord } | { ok: false; reason: string }> {
  const response = await requestText(url, context)
  if (!response.ok) return response
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, reason: `HTTP ${response.status}.` }
  }
  if (!isHtml(response.contentType, response.body)) return { ok: false, reason: 'Not HTML.' }

  const meta = extractPageMeta(response.body)
  const title = oneLine(meta.title, MAX_TITLE_LENGTH) || fallbackTitle(response.url)
  const description = oneLine(meta.description, MAX_DESCRIPTION_LENGTH)
  return { ok: true, page: { url: response.url, title, description } }
}

/**
 * Decide whether the content type or the markup is HTML.
 * @param contentType - Content-Type header.
 * @param body - Response body.
 * @returns True when title and description extraction is worthwhile.
 */
function isHtml(contentType: string, body: string): boolean {
  const type = contentType.toLowerCase()
  if (type.includes('text/html') || type.includes('application/xhtml+xml')) return true
  if (type && !type.includes('text/plain')) return false
  const start = body.slice(0, 500).toLowerCase()
  return start.includes('<html') || start.includes('<title') || start.includes('<!doctype html')
}

/**
 * Use the homepage title as the H1 when the sitemap includes it.
 * @param pages - Pages that were read.
 * @param hostname - Sitemap hostname.
 * @returns The H1 text.
 */
function siteHeading(pages: PageRecord[], hostname: string): string {
  const home = homePage(pages)
  if (home?.title) return home.title
  return hostname
}

/**
 * Use the homepage meta description as the blockquote when it exists.
 * @param pages - Pages that were read.
 * @param hostname - Sitemap hostname.
 * @returns The blockquote text.
 */
function siteSummary(pages: PageRecord[], hostname: string): string {
  const home = homePage(pages)
  if (home?.description) return home.description
  return `${pages.length} pages from ${hostname}.`
}

/**
 * Find the site root among crawled pages.
 * @param pages - Pages that were read.
 * @returns The root page, or undefined.
 */
function homePage(pages: PageRecord[]): PageRecord | undefined {
  return pages.find(page => {
    const path = new URL(page.url).pathname
    return path === '/' || path === '/index.html' || path === '/index.htm'
  })
}

/**
 * Clamp a requested page count to the hard cap.
 * @param value - Requested maximum. Omitted means the cap.
 * @returns A page count from 1 to 50.
 */
function clampMaxPages(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return MAX_PAGES
  const floored = Math.floor(value)
  if (floored < 1) return 1
  if (floored > MAX_PAGES) return MAX_PAGES
  return floored
}

/**
 * Wait between requests.
 * @param ms - Milliseconds to wait.
 * @returns A promise that resolves after the wait.
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

/**
 * Fetch with the platform implementation.
 * @param url - Absolute URL.
 * @param init - Request options.
 * @returns The platform response.
 */
function defaultFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, init)
}
