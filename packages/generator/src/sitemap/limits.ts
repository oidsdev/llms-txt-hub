/** Pages included in one draft. */
export const MAX_PAGES = 50

/** Minimum gap between requests. */
export const MIN_INTERVAL_MS = 1000

/** Upper bound for a robots.txt Crawl-delay. */
export const MAX_CRAWL_DELAY_MS = 60_000

/** Bytes read from one response before it is cut off. */
export const MAX_BODY_BYTES = 1_000_000

/** Time allowed for one request. */
export const REQUEST_TIMEOUT_MS = 15_000

/** Redirects followed for a single resource. */
export const MAX_REDIRECTS = 5

/** Identifies this crawler in robots.txt and request logs. */
export const USER_AGENT = 'llms-txt-hub-generator/1.0 (+https://llmstxthub.com)'

/** Characters kept from a title. */
export const MAX_TITLE_LENGTH = 180

/** Characters kept from a description or blockquote. */
export const MAX_DESCRIPTION_LENGTH = 300
