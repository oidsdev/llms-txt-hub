import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

export type LookupHost = (hostname: string) => Promise<string[]>

export interface PublicUrl {
  ok: true
  url: URL
}

export interface RejectedUrl {
  ok: false
  reason: string
}

/**
 * Resolve a hostname to its addresses.
 * @param hostname - Hostname without a port.
 * @returns IP addresses for the host.
 */
export async function lookupHost(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map(record => record.address)
}

/**
 * Accept only public http(s) URLs on ports 80 and 443.
 * @param raw - Candidate URL.
 * @param resolve - DNS lookup used for hostnames.
 * @returns The parsed URL, or a reason it was refused.
 */
export async function assertPublicUrl(
  raw: string,
  resolve: LookupHost
): Promise<PublicUrl | RejectedUrl> {
  const parsed = parseHttpUrl(raw)
  if (!parsed.ok) return parsed

  const hostname = hostnameOf(parsed.url)
  if (isBlockedHostname(hostname)) {
    return { ok: false, reason: 'Local and internal hosts are refused.' }
  }

  if (isIpLiteral(hostname)) {
    if (isPrivateAddress(hostname)) {
      return { ok: false, reason: 'Private addresses are refused.' }
    }
    return { ok: true, url: parsed.url }
  }

  const resolved = await resolveAddresses(hostname, resolve)
  if (!resolved.ok) return resolved
  if (resolved.addresses.some(address => isPrivateAddress(address))) {
    return { ok: false, reason: 'Host resolves to a private address.' }
  }

  return { ok: true, url: parsed.url }
}

/**
 * Parse an http(s) URL and reject credentials and unusual ports.
 * @param raw - Candidate URL.
 * @returns The parsed URL, or a reason it was refused.
 */
function parseHttpUrl(raw: string): PublicUrl | RejectedUrl {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'Invalid URL.' }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'Only http and https URLs are fetched.' }
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'URLs with credentials are refused.' }
  }
  if (url.port !== '' && url.port !== '80' && url.port !== '443') {
    return { ok: false, reason: 'Only ports 80 and 443 are fetched.' }
  }
  if (url.hostname.endsWith('.')) url.hostname = url.hostname.replace(/\.$/, '')

  return { ok: true, url }
}

/**
 * Look up a hostname and turn DNS failures into a refusal.
 * @param hostname - Hostname to resolve.
 * @param resolve - DNS lookup.
 * @returns Addresses, or a reason the lookup failed.
 */
async function resolveAddresses(
  hostname: string,
  resolve: LookupHost
): Promise<{ ok: true; addresses: string[] } | RejectedUrl> {
  try {
    const addresses = await resolve(hostname)
    if (addresses.length === 0) {
      return { ok: false, reason: 'Could not resolve host.' }
    }
    return { ok: true, addresses }
  } catch {
    return { ok: false, reason: 'Could not resolve host.' }
  }
}

/**
 * Read the hostname without brackets or a trailing dot.
 * @param url - Parsed URL.
 * @returns Lowercase hostname.
 */
function hostnameOf(url: URL): string {
  return url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase()
}

/**
 * Refuse loopback names, numeric IPs written as hostnames, and internal suffixes.
 * @param hostname - Lowercase hostname.
 * @returns True when the host must not be fetched.
 */
function isBlockedHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true
  if (hostname.endsWith('.local')) return true
  if (hostname === 'metadata.google.internal' || hostname.endsWith('.internal')) return true
  if (hostname === 'home.arpa' || hostname.endsWith('.home.arpa')) return true
  if (hostname === 'onion' || hostname.endsWith('.onion')) return true
  if (/^\d+$/.test(hostname) || hostname.startsWith('0x')) return true
  return false
}

const blockedAddresses = new BlockList()
blockedAddresses.addSubnet('0.0.0.0', 8, 'ipv4')
blockedAddresses.addSubnet('10.0.0.0', 8, 'ipv4')
blockedAddresses.addSubnet('100.64.0.0', 10, 'ipv4')
blockedAddresses.addSubnet('127.0.0.0', 8, 'ipv4')
blockedAddresses.addSubnet('169.254.0.0', 16, 'ipv4')
blockedAddresses.addSubnet('172.16.0.0', 12, 'ipv4')
blockedAddresses.addSubnet('192.0.0.0', 24, 'ipv4')
blockedAddresses.addSubnet('192.0.2.0', 24, 'ipv4')
blockedAddresses.addSubnet('192.168.0.0', 16, 'ipv4')
blockedAddresses.addSubnet('198.18.0.0', 15, 'ipv4')
blockedAddresses.addSubnet('198.51.100.0', 24, 'ipv4')
blockedAddresses.addSubnet('203.0.113.0', 24, 'ipv4')
blockedAddresses.addSubnet('224.0.0.0', 4, 'ipv4')
blockedAddresses.addSubnet('240.0.0.0', 4, 'ipv4')
blockedAddresses.addAddress('::', 'ipv6')
blockedAddresses.addAddress('::1', 'ipv6')
blockedAddresses.addSubnet('fc00::', 7, 'ipv6')
blockedAddresses.addSubnet('fe80::', 10, 'ipv6')

/**
 * Detect an IPv4 or IPv6 literal.
 * @param hostname - Hostname with brackets already removed.
 * @returns True when the hostname is an IP literal.
 */
function isIpLiteral(hostname: string): boolean {
  return isIP(hostname) !== 0
}

/**
 * Refuse loopback, private, link-local, and reserved addresses.
 * @param address - IP address from the URL or from DNS.
 * @returns True when the address must not be fetched.
 */
function isPrivateAddress(address: string): boolean {
  const host = address.toLowerCase().replace(/^\[|\]$/g, '')
  const version = isIP(host)
  if (version === 0) return true
  return blockedAddresses.check(host, version === 4 ? 'ipv4' : 'ipv6')
}
