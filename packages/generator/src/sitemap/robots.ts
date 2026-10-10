export interface RobotsRule {
  path: string
  allow: boolean
}

export interface RobotsGroup {
  agents: string[]
  rules: RobotsRule[]
  crawlDelaySeconds?: number
}

/**
 * Parse robots.txt into user-agent groups.
 * @param body - Raw robots.txt text.
 * @returns Groups in file order.
 */
export function parseRobotsTxt(body: string): RobotsGroup[] {
  const groups: RobotsGroup[] = []
  let current: RobotsGroup | undefined

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const separator = line.indexOf(':')
    if (separator === -1) continue
    const field = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()
    current = applyRobotsField(groups, current, field, value)
  }

  return groups
}

/**
 * Choose the group that applies to this crawler.
 * A specific user-agent wins over `*`. Groups are not merged.
 * @param groups - Parsed groups.
 * @param userAgent - Crawler user-agent string.
 * @returns The matching group, or undefined when no group matches.
 */
export function matchingGroup(groups: RobotsGroup[], userAgent: string): RobotsGroup | undefined {
  const ua = userAgent.toLowerCase()
  let best: RobotsGroup | undefined
  let bestLength = 0

  for (const group of groups) {
    for (const agent of group.agents) {
      if (agent === '*' || agent.length === 0) continue
      if (ua.includes(agent) && agent.length > bestLength) {
        best = group
        bestLength = agent.length
      }
    }
  }

  if (best) return best
  return groups.find(group => group.agents.includes('*'))
}

/**
 * Decide whether a URL path is allowed by the selected group.
 * The longest matching rule wins. An equal-length Allow beats Disallow.
 * @param group - Selected robots group. Missing means allow.
 * @param url - Absolute URL to test.
 * @returns True when the crawler may fetch the URL.
 */
export function isPathAllowed(group: RobotsGroup | undefined, url: URL): boolean {
  if (!group) return true
  const target = `${url.pathname}${url.search}`
  let winner: { length: number; allow: boolean } | undefined

  for (const rule of group.rules) {
    if (!ruleMatches(rule.path, target)) continue
    if (ruleWins(rule, winner)) winner = { length: rule.path.length, allow: rule.allow }
  }

  return winner ? winner.allow : true
}

/**
 * Keep a rule when it is more specific than the current winner.
 * @param rule - Candidate robots rule.
 * @param winner - Longest match so far.
 * @returns True when the candidate should replace the winner.
 */
function ruleWins(
  rule: RobotsRule,
  winner: { length: number; allow: boolean } | undefined
): boolean {
  if (!winner) return true
  if (rule.path.length > winner.length) return true
  return rule.path.length === winner.length && rule.allow && !winner.allow
}

/**
 * Read Crawl-delay in milliseconds.
 * @param group - Selected robots group.
 * @returns Delay in milliseconds, or undefined when the group has none.
 */
export function crawlDelayMs(group: RobotsGroup | undefined): number | undefined {
  if (group?.crawlDelaySeconds === undefined) return undefined
  return Math.round(group.crawlDelaySeconds * 1000)
}

/**
 * Apply one robots.txt field to the group list.
 * @param groups - Groups collected so far.
 * @param current - Group currently being filled.
 * @param field - Lowercase field name.
 * @param value - Field value.
 * @returns The group that should receive the next field.
 */
function applyRobotsField(
  groups: RobotsGroup[],
  current: RobotsGroup | undefined,
  field: string,
  value: string
): RobotsGroup | undefined {
  if (field === 'user-agent') return startAgent(groups, current, value)
  if (!current) return current
  if (field === 'allow' || field === 'disallow') {
    current.rules.push({ path: value, allow: field === 'allow' })
    return current
  }
  if (field === 'crawl-delay') return applyCrawlDelay(current, value)
  return current
}

/**
 * Start a group, or add another agent to the open group.
 * @param groups - Groups collected so far.
 * @param current - Group currently being filled.
 * @param value - User-agent token.
 * @returns The group that owns this agent.
 */
function startAgent(
  groups: RobotsGroup[],
  current: RobotsGroup | undefined,
  value: string
): RobotsGroup {
  const hasRules = current !== undefined && current.rules.length > 0
  const hasDelay = current?.crawlDelaySeconds !== undefined
  if (!current || hasRules || hasDelay) {
    const next: RobotsGroup = { agents: [], rules: [] }
    groups.push(next)
    next.agents.push(value.toLowerCase())
    return next
  }
  current.agents.push(value.toLowerCase())
  return current
}

/**
 * Store a numeric Crawl-delay on the current group.
 * @param current - Group currently being filled.
 * @param value - Raw delay in seconds.
 * @returns The same group.
 */
function applyCrawlDelay(current: RobotsGroup, value: string): RobotsGroup {
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelaySeconds = seconds
  return current
}

/**
 * Match a robots path against the URL path and query.
 * `*` matches any sequence. A trailing `$` anchors the end.
 * @param pattern - Robots path value.
 * @param pathAndQuery - URL path plus query string.
 * @returns True when the rule matches.
 */
function ruleMatches(pattern: string, pathAndQuery: string): boolean {
  if (pattern === '') return false
  const endAnchor = pattern.endsWith('$')
  const source = endAnchor ? pattern.slice(0, -1) : pattern
  let expression = '^'
  for (const char of source) {
    expression += char === '*' ? '.*' : escapeRegex(char)
  }
  if (endAnchor) expression += '$'
  return new RegExp(expression).test(pathAndQuery)
}

/**
 * Escape one character for a regular expression.
 * @param char - Character from a robots path.
 * @returns The escaped character.
 */
function escapeRegex(char: string): string {
  return char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}
