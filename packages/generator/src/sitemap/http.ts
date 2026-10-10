import { gunzipSync } from 'node:zlib'

import { MAX_BODY_BYTES, MAX_REDIRECTS } from './limits'
import { assertPublicUrl, type LookupHost } from './safety'

export interface RateLimiter {
  wait(): Promise<void>
  setIntervalMs(ms: number): void
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface RequestContext {
  fetch: FetchLike
  lookup: LookupHost
  limiter: RateLimiter
  timeoutMs: number
  userAgent: string
  host: string
}

export interface HttpSuccess {
  ok: true
  status: number
  url: string
  contentType: string
  body: string
}

export interface HttpFailure {
  ok: false
  reason: string
}

interface Fetched {
  ok: true
  status: number
  location: string
  contentType: string
  body: string
}

/**
 * Space requests so each one starts at least intervalMs after the previous one.
 * @param intervalMs - Gap between request starts.
 * @param now - Clock in milliseconds.
 * @param sleep - Wait helper. Tests can advance a fake clock here.
 * @returns A limiter shared by every fetch in one crawl.
 */
export function createRateLimiter(
  intervalMs: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>
): RateLimiter {
  let interval = intervalMs
  let nextAt = 0
  let lastStart = 0

  return {
    setIntervalMs(ms: number): void {
      interval = ms
      const earliest = lastStart + ms
      if (earliest > nextAt) nextAt = earliest
    },
    async wait(): Promise<void> {
      const current = now()
      const delay = Math.max(0, nextAt - current)
      if (delay > 0) await sleep(delay)
      lastStart = now()
      nextAt = lastStart + interval
    }
  }
}

/**
 * Fetch one URL, follow same-host redirects, and return the body as text.
 * @param rawUrl - Absolute URL.
 * @param context - Fetch, DNS, rate limit, and host lock for this crawl.
 * @returns The response body, or a reason the fetch stopped.
 */
export async function requestText(
  rawUrl: string,
  context: RequestContext
): Promise<HttpSuccess | HttpFailure> {
  let current = rawUrl
  const seen = new Set<string>()

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (seen.has(current)) return { ok: false, reason: 'Redirect loop.' }
    seen.add(current)

    const hostCheck = sameHost(current, context.host)
    if (!hostCheck.ok) return hostCheck

    const checked = await assertPublicUrl(current, context.lookup)
    if (!checked.ok) return { ok: false, reason: checked.reason }

    await context.limiter.wait()
    const response = await fetchOnce(checked.url.toString(), context)
    if (!response.ok) return response

    if (response.status >= 300 && response.status < 400) {
      const next = redirectTarget(response.location, checked.url)
      if (!next.ok) return next
      current = next.url
      continue
    }

    return {
      ok: true,
      status: response.status,
      url: checked.url.toString(),
      contentType: response.contentType,
      body: response.body
    }
  }

  return { ok: false, reason: 'Too many redirects.' }
}

/**
 * Refuse a URL that is not on the sitemap host.
 * @param raw - Absolute URL.
 * @param host - Host locked at the start of the crawl, including a non-default port.
 * @returns Ok, or a reason the host did not match.
 */
function sameHost(raw: string, host: string): { ok: true } | HttpFailure {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'Invalid URL.' }
  }
  if (url.host !== host) return { ok: false, reason: 'Redirect left the sitemap host.' }
  return { ok: true }
}

/**
 * Perform one HTTP request and decode a limited body.
 * @param url - Absolute URL already checked.
 * @param context - Fetch options for this crawl.
 * @returns Status, headers of interest, and the decoded body.
 */
async function fetchOnce(url: string, context: RequestContext): Promise<Fetched | HttpFailure> {
  const timeout = startTimeout(context.timeoutMs)
  try {
    const response = await context.fetch(url, {
      headers: {
        accept:
          'text/html,application/xhtml+xml,application/xml,text/xml,text/plain;q=0.9,*/*;q=0.8',
        'user-agent': context.userAgent
      },
      redirect: 'manual',
      signal: timeout.signal
    })
    const contentType = response.headers.get('content-type') ?? ''
    const location = response.headers.get('location') ?? ''
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      return { ok: true, status: response.status, location, contentType, body: '' }
    }
    const bytes = await readLimited(response, MAX_BODY_BYTES)
    const decoded = decodePayload(bytes, contentType)
    if (!decoded.ok) return decoded
    return { ok: true, status: response.status, location, contentType, body: decoded.text }
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'AbortError'
    return { ok: false, reason: timedOut ? 'Request timed out.' : 'Request failed.' }
  } finally {
    timeout.done()
  }
}

/**
 * Abort a request after the timeout.
 * @param timeoutMs - Milliseconds before the request is aborted.
 * @returns The signal and a function that clears the timer.
 */
function startTimeout(timeoutMs: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer)
    }
  }
}

/**
 * Read a response body up to a byte limit.
 * @param response - Fetch response.
 * @param maxBytes - Maximum bytes to keep.
 * @returns The bytes that were read.
 */
async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()

  const chunks: Uint8Array[] = []
  let total = 0
  while (total < maxBytes) {
    const step = await reader.read()
    if (step.done) break
    const room = maxBytes - total
    const slice = step.value.byteLength > room ? step.value.subarray(0, room) : step.value
    chunks.push(slice)
    total += slice.byteLength
    if (step.value.byteLength > room) {
      await reader.cancel()
      break
    }
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

/**
 * Gunzip a gzip payload when needed, then decode text.
 * @param bytes - Response bytes.
 * @param contentType - Content-Type header.
 * @returns Decoded text, or a reason decompression failed.
 */
function decodePayload(
  bytes: Uint8Array,
  contentType: string
): { ok: true; text: string } | HttpFailure {
  let payload = bytes
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const inflated = inflate(bytes)
    if (!inflated) return { ok: false, reason: 'Could not decompress response.' }
    payload = inflated
  }

  try {
    return { ok: true, text: new TextDecoder(charsetName(contentType)).decode(payload) }
  } catch {
    return { ok: true, text: new TextDecoder('utf-8').decode(payload) }
  }
}

/**
 * Decompress a gzip body, refusing output past the byte limit.
 * @param bytes - Gzip bytes.
 * @returns Inflated bytes, or undefined when decompression fails.
 */
function inflate(bytes: Uint8Array): Uint8Array | undefined {
  try {
    return gunzipSync(bytes, { maxOutputLength: MAX_BODY_BYTES })
  } catch {
    return undefined
  }
}

/**
 * Pick a text encoding from a Content-Type header.
 * @param contentType - Content-Type header value.
 * @returns An encoding name TextDecoder accepts.
 */
function charsetName(contentType: string): string {
  const match = contentType.match(/charset=([^;]+)/i)
  const charset = match?.[1]?.trim().replace(/["']/g, '').toLowerCase()
  if (!charset) return 'utf-8'
  if (charset === 'iso-8859-1' || charset === 'latin1' || charset === 'windows-1252') {
    return 'windows-1252'
  }
  return charset
}

/**
 * Resolve a redirect Location against the current URL.
 * @param location - Location header value.
 * @param base - URL that returned the redirect.
 * @returns The next absolute URL, or a reason it could not be read.
 */
function redirectTarget(location: string, base: URL): { ok: true; url: string } | HttpFailure {
  if (!location) return { ok: false, reason: 'Redirect was missing a Location header.' }
  try {
    return { ok: true, url: new URL(location, base).toString() }
  } catch {
    return { ok: false, reason: 'Redirect location was invalid.' }
  }
}
