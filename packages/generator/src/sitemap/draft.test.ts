import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { gzipSync } from 'node:zlib'

import { extractPageMeta } from './extract-meta'
import { type GenerateOptions, generateFromSitemap } from './generate'
import type { FetchLike } from './http'
import { parseSitemap } from './parse-sitemap'
import { renderLlmsTxt } from './render'
import { assertPublicUrl } from './safety'
import { fallbackTitle } from './text'

interface Route {
  status?: number
  body?: BodyInit
  headers?: Record<string, string>
}

interface Harness {
  calls: string[]
  sleeps: number[]
  options: Pick<GenerateOptions, 'fetch' | 'lookup' | 'now' | 'sleep'>
}

function page(title: string, description?: string): string {
  const meta = description ? `<meta name="description" content="${description}">` : ''
  return `<!doctype html><html><head><title>${title}</title>${meta}</head><body></body></html>`
}

function createHarness(routes: Record<string, Route>): Harness {
  const calls: string[] = []
  const sleeps: number[] = []
  let time = 0
  const fetchImpl: FetchLike = async url => {
    calls.push(url)
    const route = routes[url]
    if (!route) return new Response('missing', { status: 404 })
    return new Response(route.body ?? '', {
      status: route.status ?? 200,
      headers: route.headers
    })
  }

  return {
    calls,
    sleeps,
    options: {
      fetch: fetchImpl,
      lookup: async hostname => (hostname === 'example.com' ? ['93.184.216.34'] : ['127.0.0.1']),
      now: () => time,
      sleep: async ms => {
        sleeps.push(ms)
        time += ms
      }
    }
  }
}

describe('parseSitemap', () => {
  it('decodes loc entities and tells an index from a urlset', () => {
    const urlset = parseSitemap(
      '<urlset><url><loc>https://example.com/a?x=1&amp;y=2</loc></url></urlset>'
    )
    assert.equal(urlset.kind, 'urlset')
    assert.deepEqual(urlset.locs, ['https://example.com/a?x=1&y=2'])

    const index = parseSitemap(
      '<sitemapindex><sitemap><loc><![CDATA[https://example.com/child.xml]]></loc></sitemap></sitemapindex>'
    )
    assert.equal(index.kind, 'index')
    assert.deepEqual(index.locs, ['https://example.com/child.xml'])
  })
})

describe('extractPageMeta', () => {
  it('prefers the title element and the description meta tag', () => {
    const meta = extractPageMeta(`
      <html><head>
        <meta property="og:description" content="From Open Graph">
        <meta name="description" content="Fish &amp; chips">
        <title>  Hello   world </title>
        <meta property="og:title" content="OG title">
      </head></html>
    `)
    assert.equal(meta.title, 'Hello   world')
    assert.equal(meta.description, 'Fish & chips')
  })

  it('falls back to Open Graph when the standard tags are missing', () => {
    const meta = extractPageMeta(`
      <html><head>
        <meta property="og:title" content="OG title">
        <meta property="og:description" content="OG description">
      </head></html>
    `)
    assert.equal(meta.title, 'OG title')
    assert.equal(meta.description, 'OG description')
  })
})

describe('renderLlmsTxt', () => {
  it('omits a missing description and names sections from the path', () => {
    const markdown = renderLlmsTxt({
      title: 'Example',
      summary: 'Summary',
      note: 'Draft note.',
      pages: [
        { url: 'https://example.com/docs/getting-started', title: 'Start', description: '' },
        { url: 'https://example.com/docs/api', title: 'API', description: 'Reference' }
      ]
    })

    assert.match(markdown, /^# Example\n\n> Summary\n\nDraft note.\n/)
    assert.match(
      markdown,
      /## Docs\n\n- \[Start\]\(https:\/\/example.com\/docs\/getting-started\)\n/
    )
    assert.match(markdown, /- \[API\]\(https:\/\/example.com\/docs\/api\): Reference\n/)
    assert.equal(fallbackTitle('https://example.com/docs/getting-started'), 'Getting started')
  })
})

describe('assertPublicUrl', () => {
  it('refuses local, private, credential, and unusual-port URLs', async () => {
    const lookup = async () => {
      throw new Error('lookup should not run')
    }
    const refused = [
      'http://127.0.0.1/sitemap.xml',
      'http://2130706433/sitemap.xml',
      'http://10.1.2.3/sitemap.xml',
      'http://169.254.169.254/sitemap.xml',
      'http://[::1]/sitemap.xml',
      'http://[::ffff:7f00:1]/sitemap.xml',
      'https://user:pass@example.com/sitemap.xml',
      'https://example.com:8443/sitemap.xml',
      'https://localhost/sitemap.xml',
      'ftp://example.com/sitemap.xml'
    ]
    for (const url of refused) {
      const result = await assertPublicUrl(url, lookup)
      assert.equal(result.ok, false, url)
    }
  })

  it('allows a public address literal without a lookup', async () => {
    const result = await assertPublicUrl('https://93.184.216.34/', async () => {
      throw new Error('lookup should not run')
    })
    assert.equal(result.ok, true)
  })

  it('refuses a hostname that resolves to a private address', async () => {
    const result = await assertPublicUrl('https://example.com/sitemap.xml', async () => [
      '127.0.0.1'
    ])
    assert.equal(result.ok, false)
  })
})

describe('generateFromSitemap', () => {
  it('writes an H1, a summary blockquote, and H2 sections', async () => {
    const harness = createHarness({
      'https://example.com/sitemap.xml': {
        headers: { 'content-type': 'application/xml' },
        body: `<?xml version="1.0"?>
          <urlset>
            <url><loc>https://example.com/</loc></url>
            <url><loc>https://example.com/docs/start</loc></url>
            <url><loc>https://example.com/docs/api</loc></url>
            <url><loc>https://example.com/blog/hello</loc></url>
            <url><loc>https://other.example/nope</loc></url>
          </urlset>`
      },
      'https://example.com/': { body: page('Example Docs', 'Guides for the Example widget.') },
      'https://example.com/docs/start': { body: page('Quickstart', 'Install and run.') },
      'https://example.com/docs/api': { body: page('API reference', 'HTTP endpoints.') },
      'https://example.com/blog/hello': {
        body: '<html><head><meta property="og:description" content="First post."><title>Hello</title></head></html>'
      }
    })

    const result = await generateFromSitemap({
      sitemapUrl: 'https://example.com/sitemap.xml',
      ...harness.options
    })

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(
      result.markdown,
      `# Example Docs

> Guides for the Example widget.

Draft generated from https://example.com/sitemap.xml. 4 pages. Review before publishing.

## Home

- [Example Docs](https://example.com/): Guides for the Example widget.

## Docs

- [Quickstart](https://example.com/docs/start): Install and run.
- [API reference](https://example.com/docs/api): HTTP endpoints.

## Blog

- [Hello](https://example.com/blog/hello): First post.
`
    )
    assert.deepEqual(harness.sleeps, [1000, 1000, 1000, 1000, 1000])
    assert.equal(harness.calls.includes('https://other.example/nope'), false)
    assert.ok(result.warnings.some(warning => warning.includes('another host')))
  })

  it('caps the draft at 50 pages and does not fetch the rest', async () => {
    const locs = Array.from(
      { length: 51 },
      (_, index) => `<url><loc>https://example.com/p/${index}</loc></url>`
    ).join('')
    const routes: Record<string, Route> = {
      'https://example.com/sitemap.xml': {
        headers: { 'content-type': 'application/xml' },
        body: `<urlset>${locs}</urlset>`
      }
    }
    for (let index = 0; index < 51; index += 1) {
      routes[`https://example.com/p/${index}`] = { body: page(`Page ${index}`, `Note ${index}`) }
    }
    const harness = createHarness(routes)
    const result = await generateFromSitemap({
      sitemapUrl: 'https://example.com/sitemap.xml',
      maxPages: 80,
      ...harness.options
    })

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.pages.length, 50)
    assert.equal(harness.calls.includes('https://example.com/p/50'), false)
    assert.equal(harness.sleeps.length, harness.calls.length - 1)
    assert.ok(harness.sleeps.every(delay => delay >= 1000))
    assert.ok(result.warnings.some(warning => warning.includes('first 50')))
  })

  it('skips URLs disallowed by robots.txt', async () => {
    const harness = createHarness({
      'https://example.com/robots.txt': {
        headers: { 'content-type': 'text/plain' },
        body: 'User-agent: *\nDisallow: /private\n'
      },
      'https://example.com/sitemap.xml': {
        headers: { 'content-type': 'application/xml' },
        body: `<urlset>
          <url><loc>https://example.com/private/secret</loc></url>
          <url><loc>https://example.com/docs</loc></url>
        </urlset>`
      },
      'https://example.com/docs': { body: page('Docs', 'Public docs.') }
    })
    const result = await generateFromSitemap({
      sitemapUrl: 'https://example.com/sitemap.xml',
      ...harness.options
    })

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(
      result.pages.map(item => item.url),
      ['https://example.com/docs']
    )
    assert.equal(harness.calls.includes('https://example.com/private/secret'), false)
  })

  it('stops when robots.txt returns a server error', async () => {
    const harness = createHarness({
      'https://example.com/robots.txt': { status: 503, body: '' },
      'https://example.com/sitemap.xml': {
        body: '<urlset><url><loc>https://example.com/</loc></url></urlset>'
      }
    })
    const result = await generateFromSitemap({
      sitemapUrl: 'https://example.com/sitemap.xml',
      ...harness.options
    })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.reason, /503/)
    assert.deepEqual(harness.calls, ['https://example.com/robots.txt'])
  })

  it('waits out a crawl-delay before the next request', async () => {
    const harness = createHarness({
      'https://example.com/robots.txt': {
        body: 'User-agent: llms-txt-hub-generator\nCrawl-delay: 2\nDisallow:\n'
      },
      'https://example.com/sitemap.xml': {
        headers: { 'content-type': 'application/xml' },
        body: '<urlset><url><loc>https://example.com/guide</loc></url></urlset>'
      },
      'https://example.com/guide': { body: page('Guide', 'A guide.') }
    })
    const result = await generateFromSitemap({
      sitemapUrl: 'https://example.com/sitemap.xml',
      ...harness.options
    })
    assert.equal(result.ok, true)
    assert.deepEqual(harness.sleeps, [2000, 2000])
  })

  it('reads one level of sitemap index and a gzip body', async () => {
    const child = `<urlset>
      <url><loc>https://example.com/a</loc></url>
      <url><loc>https://example.com/b</loc></url>
      <url><loc>https://example.com/c</loc></url>
    </urlset>`
    const harness = createHarness({
      'https://example.com/sitemap.xml': {
        headers: { 'content-type': 'application/gzip' },
        body: gzipSync(
          `<sitemapindex>
            <sitemap><loc>https://example.com/a.xml</loc></sitemap>
            <sitemap><loc>https://example.com/b.xml</loc></sitemap>
          </sitemapindex>`
        )
      },
      'https://example.com/a.xml': {
        headers: { 'content-type': 'application/xml' },
        body: child
      },
      'https://example.com/b.xml': {
        headers: { 'content-type': 'application/xml' },
        body: '<urlset><url><loc>https://example.com/from-b</loc></url></urlset>'
      },
      'https://example.com/a': { body: page('A', 'Page A') },
      'https://example.com/b': { body: page('B', 'Page B') }
    })
    const result = await generateFromSitemap({
      sitemapUrl: 'https://example.com/sitemap.xml',
      maxPages: 2,
      ...harness.options
    })

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(
      result.pages.map(item => item.url),
      ['https://example.com/a', 'https://example.com/b']
    )
    assert.equal(harness.calls.includes('https://example.com/b.xml'), false)
    assert.equal(harness.calls.includes('https://example.com/c'), false)
  })

  it('does not fetch a private sitemap', async () => {
    let called = false
    const result = await generateFromSitemap({
      sitemapUrl: 'http://127.0.0.1/sitemap.xml',
      fetch: async () => {
        called = true
        return new Response('')
      },
      lookup: async () => ['93.184.216.34']
    })
    assert.equal(result.ok, false)
    assert.equal(called, false)
  })
})
