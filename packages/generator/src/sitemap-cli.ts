#!/usr/bin/env node

import { writeFile } from 'node:fs/promises'

import { Command } from 'commander'

import { generateFromSitemap } from './sitemap/generate'

interface CliOptions {
  sitemap: string
  out?: string
  maxPages: number
}

/**
 * Read CLI flags.
 * @param raw - Commander option bag.
 * @returns Parsed options, or undefined when the sitemap is missing.
 */
function readOptions(raw: {
  sitemap?: unknown
  out?: unknown
  maxPages?: unknown
}): CliOptions | undefined {
  if (typeof raw.sitemap !== 'string') return undefined
  const out = typeof raw.out === 'string' ? raw.out : undefined
  const parsed = typeof raw.maxPages === 'string' ? Number.parseInt(raw.maxPages, 10) : 50
  return { sitemap: raw.sitemap, out, maxPages: parsed }
}

/**
 * Draft llms.txt from a sitemap and write it to a file or stdout.
 * @returns Nothing. Sets the process exit code when the crawl fails.
 */
async function run(): Promise<void> {
  const program = new Command()
  program
    .name('generate-llmstxt-sitemap')
    .description('Draft an llms.txt file from a sitemap')
    .requiredOption('-s, --sitemap <url>', 'Sitemap URL')
    .option('-o, --out <file>', 'Write the draft to this file')
    .option('-m, --max-pages <number>', 'Pages to include, up to 50', '50')
  program.parse()

  const options = readOptions(program.opts())
  if (!options) {
    console.error('Pass a sitemap URL with --sitemap.')
    process.exitCode = 1
    return
  }

  const result = await generateFromSitemap({
    sitemapUrl: options.sitemap,
    maxPages: options.maxPages
  })

  for (const warning of result.warnings) console.error(`warning: ${warning}`)
  if (!result.ok) {
    console.error(result.reason)
    process.exitCode = 1
    return
  }

  for (const skipped of result.skipped) {
    console.error(`skipped ${skipped.url}: ${skipped.reason}`)
  }
  if (options.out) {
    await writeFile(options.out, result.markdown, 'utf8')
    console.error(`Wrote ${options.out}`)
    return
  }
  process.stdout.write(result.markdown)
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown error.'
  console.error(message)
  process.exitCode = 1
})
