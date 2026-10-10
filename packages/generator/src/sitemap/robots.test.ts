import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { USER_AGENT } from './limits'
import { crawlDelayMs, isPathAllowed, matchingGroup, parseRobotsTxt } from './robots'

describe('parseRobotsTxt', () => {
  it('lets the longest matching rule win, and Allow win a tie', () => {
    const groups = parseRobotsTxt(`
User-agent: *
Disallow: /
Allow: /docs
Allow: /docs
Disallow: /docs
`)
    const group = matchingGroup(groups, USER_AGENT)
    assert.equal(isPathAllowed(group, new URL('https://example.com/docs/start')), true)
    assert.equal(isPathAllowed(group, new URL('https://example.com/blog')), false)
  })

  it('uses a specific user-agent group on its own', () => {
    const groups = parseRobotsTxt(`
User-agent: *
Disallow: /docs

User-agent: llms-txt-hub-generator
Disallow: /private
Crawl-delay: 2
`)
    const group = matchingGroup(groups, USER_AGENT)
    assert.equal(isPathAllowed(group, new URL('https://example.com/docs')), true)
    assert.equal(isPathAllowed(group, new URL('https://example.com/private/note')), false)
    assert.equal(crawlDelayMs(group), 2000)
  })

  it('treats an empty Disallow as no block', () => {
    const groups = parseRobotsTxt(`
User-agent: *
Disallow:
`)
    const group = matchingGroup(groups, USER_AGENT)
    assert.equal(isPathAllowed(group, new URL('https://example.com/any')), true)
  })

  it('anchors $ and expands *', () => {
    const groups = parseRobotsTxt(`
User-agent: *
Disallow: /*.pdf$
`)
    const group = matchingGroup(groups, 'someone-else')
    assert.equal(isPathAllowed(group, new URL('https://example.com/files/a.pdf')), false)
    assert.equal(isPathAllowed(group, new URL('https://example.com/files/a.pdf.txt')), true)
  })
})
