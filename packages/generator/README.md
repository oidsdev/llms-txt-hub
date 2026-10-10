# Generator

Tools for building `llms.txt` files.

## Sitemap draft

Give it a sitemap URL. It fetches each page slowly, reads the title and meta description, and writes a draft `llms.txt`.

```bash
pnpm --filter generator sitemap -- --sitemap https://example.com/sitemap.xml --out ./llms.txt
```

From the repo root:

```bash
pnpm generate:sitemap -- --sitemap https://example.com/sitemap.xml --out ./llms.txt
```

Omit `--out` to print the draft. `--max-pages` defaults to 50 and cannot go higher.

The draft looks like this:

```markdown
# Example Docs

> Guides for the Example widget.

Draft generated from https://example.com/sitemap.xml. 2 pages. Review before publishing.

## Docs

- [Quickstart](https://example.com/docs/start): Install and run.
```

- The H1 is the homepage `<title>`, or the hostname when the sitemap has no root page.
- The blockquote is the homepage meta description. Without one, it states the page count and host.
- Each H2 is the first path segment. `/docs/start` goes under Docs. `/` goes under Home.
- A link uses the page title and `meta name="description"`. Open Graph description is used when the standard tag is missing.

### Limits

- 50 pages. Later sitemap URLs are left out.
- One request per second. A robots.txt `Crawl-delay` can make that slower, up to 60 seconds.
- The crawler sends `llms-txt-hub-generator/1.0 (+https://llmstxthub.com)`. A matching user-agent group wins over `*`. Rules from the two groups are not merged.
- A 4xx `robots.txt` is treated as no rules. A 5xx stops the crawl. If `robots.txt` cannot be read, the crawl stops.
- Only the sitemap host is fetched. Other hosts, including sitemap index children, are skipped. Redirects must stay on that host.
- Only ports 80 and 443. Private, local, and credentialed URLs are refused.
- HTML only. Titles drawn by JavaScript are missed. Common non-page files (pdf, images, xml) are skipped.
- One sitemap index level. A nested index is skipped. Gzipped sitemap bodies are accepted.
- This draft does not read page bodies and does not write `llms-full.txt`. Read it before publishing.

## Firecrawl

The original command calls the Firecrawl API and writes `llms.txt` and `llms-full.txt` under `content/unofficial/`. It needs `FIRECRAWL_API_KEY` in the environment or `.env`. The sitemap command does not use that key.

```bash
pnpm --filter generator start
```
