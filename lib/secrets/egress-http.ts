// Bounded HTTPS data plane for third-party secrets only. No DB, provider/GitHub
// proxy, remote authorization preflight, cookie jar, or redirect following.
import { lookup } from 'node:dns/promises'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import type { LookupAddress } from 'node:dns'
import { CodedError } from '@mikka/protocol/coded-error'
import { egressError, openEgressCapability, type EgressCapabilityBinding, type EgressCapabilityClaims } from './egress-capability'

export const EGRESS_MAX_REQUEST_BYTES = 512 * 1024
export const EGRESS_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
export const EGRESS_TIMEOUT_MS = 20_000
const MAX_HEADER_BYTES = 16 * 1024
const MAX_CONCURRENT_REQUESTS = 32
let activeRequests = 0
const FORWARD_HEADERS = new Set(['accept', 'content-type', 'idempotency-key', 'notion-version', 'stripe-version', 'x-api-version'])
const RESPONSE_HEADERS = new Set(['content-type', 'retry-after', 'etag', 'last-modified', 'x-request-id', 'request-id'])
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
const hasControl = (value: string) => [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
const NON_PUBLIC_V4 = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) NON_PUBLIC_V4.addSubnet(address, prefix, 'ipv4')
const GLOBAL_V6 = new BlockList()
GLOBAL_V6.addSubnet('2000::', 3, 'ipv6')
const NON_PUBLIC_V6 = new BlockList()
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3ffe::', 16], ['3fff::', 20]] as const)
  NON_PUBLIC_V6.addSubnet(address, prefix, 'ipv6')

/** Deliberately excludes mapped/NAT64/tunnel ranges as well as local, metadata,
 * multicast, documentation and reserved addresses. No local-test bypass. */
export function isPublicEgressAddress(address: string): boolean {
  if (address.includes('%')) return false
  const family = isIP(address)
  return family === 4 ? !NON_PUBLIC_V4.check(address, 'ipv4')
    : family === 6 && GLOBAL_V6.check(address, 'ipv6') && !NON_PUBLIC_V6.check(address, 'ipv6')
}

export interface EgressHttpRequest {
  capability: string
  method: string
  path: string
  headers: Array<[string, string]>
  bodyBase64?: string
}
export interface EgressHttpResponse { status: number; headers: Record<string, string>; bodyBase64: string }
export interface EgressHttpTarget {
  url: URL
  method: string
  headers: Record<string, string>
  body: Buffer
  address: LookupAddress
}
export interface EgressUpstreamResponse { status: number; headers: Array<[string, string]>; body: Buffer }
export interface EgressHttpOptions {
  env?: Record<string, string | undefined>
  now?: () => number
  signal?: AbortSignal
  resolve?: (hostname: string) => Promise<LookupAddress[]>
  transport?: (target: EgressHttpTarget, signal: AbortSignal) => Promise<EgressUpstreamResponse>
}

function requestTarget(claims: EgressCapabilityClaims, input: EgressHttpRequest): Omit<EgressHttpTarget, 'address'> {
  if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['capability', 'method', 'path', 'headers', 'bodyBase64'].includes(key))
    || typeof input.method !== 'string' || !METHODS.has(input.method) || typeof input.path !== 'string'
    || input.path.length > 8 * 1024 || !input.path.startsWith('/') || input.path.startsWith('//')
    || /[\\#\s]/u.test(input.path) || hasControl(input.path)) throw egressError('invalid_request')
  const pathname = input.path.split('?')[0]
  // Upstreams may strip semicolon path parameters before normalizing dot
  // segments: /v1/..;/admin must not bypass an approved /v1 prefix. Version 1
  // supports unencoded paths without matrix parameters and normal queries.
  if (pathname.includes('%') || pathname.includes(';') || pathname.includes('//') || pathname.split('/').some(part => part === '.' || part === '..'))
    throw egressError('destination_denied')
  const url = new URL(input.path, claims.http.origin)
  if (url.protocol !== 'https:' || url.origin !== claims.http.origin || `${url.pathname}${url.search}` !== input.path
    || url.username || url.password || url.hash) throw egressError('destination_denied')
  const permitted = claims.http.rules.some(rule => {
    if (rule.method !== input.method) return false
    if (rule.match === 'exact') return pathname === rule.path
    const base = rule.path.replace(/\/+$/, '')
    return !base || pathname === base || pathname.startsWith(`${base}/`)
  })
  if (!permitted) throw egressError('destination_denied')
  if (!Array.isArray(input.headers) || input.headers.length > 32) throw egressError('invalid_request')
  const headers: Record<string, string> = {}
  const seen = new Set<string>()
  let headerBytes = 0
  for (const pair of input.headers) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string'
      || !/^[A-Za-z0-9-]{1,64}$/.test(pair[0]) || !/^[\x20-\x7e]*$/.test(pair[1])) throw egressError('invalid_request')
    const name = pair[0].toLowerCase()
    if (seen.has(name) || !FORWARD_HEADERS.has(name)) throw egressError('invalid_request')
    seen.add(name)
    headerBytes += Buffer.byteLength(name) + Buffer.byteLength(pair[1])
    if (headerBytes > MAX_HEADER_BYTES) throw egressError('limit_exceeded')
    headers[name] = pair[1]
  }
  let body = Buffer.alloc(0)
  if (input.bodyBase64 !== undefined) {
    if (typeof input.bodyBase64 !== 'string' || input.bodyBase64.length > 4 * Math.ceil(EGRESS_MAX_REQUEST_BYTES / 3))
      throw egressError('limit_exceeded')
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.bodyBase64)) throw egressError('invalid_request')
    body = Buffer.from(input.bodyBase64, 'base64')
    if (body.toString('base64') !== input.bodyBase64) throw egressError('invalid_request')
    if (body.length > EGRESS_MAX_REQUEST_BYTES) throw egressError('limit_exceeded')
  }
  if ((input.method === 'GET' || input.method === 'HEAD') && body.length) throw egressError('invalid_request')
  headers[claims.http.header] = claims.http.prefix + claims.secret
  headers['accept-encoding'] = 'identity'
  headers['content-length'] = String(body.length)
  return { url, method: input.method, headers, body }
}

/** Resolve once, then connect only to that address while retaining the approved
 * hostname for TLS certificate validation and SNI. No pooled socket or proxy
 * can silently select a second destination after the public-address check. */
export function pinnedEgressRequestOptions(target: EgressHttpTarget, signal?: AbortSignal): RequestOptions {
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, [target.address])
    else callback(null, target.address.address, target.address.family)
  }
  const hostname = target.url.hostname.replace(/^\[|\]$/g, '')
  return {
    method: target.method, headers: target.headers, agent: false, lookup: pinnedLookup,
    family: target.address.family, rejectUnauthorized: true,
    ...(isIP(hostname) ? {} : { servername: hostname }), maxHeaderSize: MAX_HEADER_BYTES,
    ...(signal ? { signal } : {}),
  }
}

async function transport(target: EgressHttpTarget, signal: AbortSignal): Promise<EgressUpstreamResponse> {
  return await new Promise((resolve, reject) => {
    const request = httpsRequest(target.url, pinnedEgressRequestOptions(target, signal), response => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (part: Buffer) => {
        size += part.length
        if (size > EGRESS_MAX_RESPONSE_BYTES) {
          const error = egressError('limit_exceeded')
          response.destroy(error); request.destroy(error)
        } else chunks.push(part)
      })
      response.once('error', reject)
      response.once('aborted', () => reject(egressError('upstream_unavailable')))
      response.once('end', () => {
        const raw = [...response.rawHeaders, ...response.rawTrailers]
        const headers: Array<[string, string]> = []
        for (let index = 0; index < raw.length; index += 2) headers.push([raw[index], raw[index + 1]])
        resolve({ status: response.statusCode ?? 502, headers, body: Buffer.concat(chunks) })
      })
    })
    request.once('error', reject)
    request.end(target.body)
  })
}

/** Reject the response before releasing any bytes. These common encodings are
 * defense in depth, not a proof against an arbitrary malicious upstream which
 * can transform its own credentials. Policies must authorize trusted API routes,
 * excluding debug/echo/key-export routes and attacker-controlled upstreams. */
function reflectionPatterns(secret: string, authorization: string): Buffer[] {
  const values = [...new Set([secret, authorization])]
  const encoded = new Set(values.flatMap(text => {
    const plain = Buffer.from(text)
    return [text, JSON.stringify(text).slice(1, -1), encodeURIComponent(text),
      plain.toString('base64'), plain.toString('base64').replace(/=+$/, ''), plain.toString('base64url'), plain.toString('hex'), plain.toString('hex').toUpperCase(),
      [...plain].map(byte => `%${byte.toString(16).padStart(2, '0')}`).join(''),
      [...plain].map(byte => `%${byte.toString(16).padStart(2, '0').toUpperCase()}`).join(''),
      [...plain].map(byte => `\\u${byte.toString(16).padStart(4, '0')}`).join(''),
    ]
  }))
  return [...encoded].map(pattern => Buffer.from(pattern)).concat(values.flatMap(text => {
    const littleEndian = Buffer.from(text, 'utf16le')
    return [littleEndian, Buffer.from(littleEndian).swap16()]
  }))
}

const reflectsSecret = (value: Buffer, patterns: readonly Buffer[]) => patterns.some(pattern => value.includes(pattern))

function checkedResponse(response: EgressUpstreamResponse, claims: EgressCapabilityClaims): EgressHttpResponse {
  if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 600
    || response.status >= 300 && response.status < 400) throw egressError('response_blocked')
  if (response.body.length > EGRESS_MAX_RESPONSE_BYTES) throw egressError('limit_exceeded')
  // Construct these once: an upstream can send many short headers, and a
  // 32-KiB key must not be re-encoded for each one on the synchronous path.
  const patterns = reflectionPatterns(claims.secret, claims.http.prefix + claims.secret)
  const headers: Record<string, string> = {}
  let size = 0
  for (const [rawName, value] of response.headers) {
    size += Buffer.byteLength(rawName) + Buffer.byteLength(value)
    if (size > MAX_HEADER_BYTES) throw egressError('limit_exceeded')
    if (reflectsSecret(Buffer.from(`${rawName}: ${value}`), patterns)) throw egressError('response_blocked')
    const name = rawName.toLowerCase()
    if (name === 'content-encoding' && value.toLowerCase() !== 'identity') throw egressError('response_blocked')
    if (RESPONSE_HEADERS.has(name)) {
      if (name in headers || hasControl(value)) throw egressError('response_blocked')
      headers[name] = value
    }
  }
  if (reflectsSecret(response.body, patterns)) throw egressError('response_blocked')
  return { status: response.status, headers, bodyBase64: response.body.toString('base64') }
}

async function untilAborted<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let cancel!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
  })
  try { return await Promise.race([work(), aborted]) }
  finally { signal.removeEventListener('abort', cancel) }
}

/** The route supplies its independently parsed run id. The request cannot add a
 * secret, owner, origin or a new operation. Concurrent/byte/deadline limits are
 * local resource bounds; they are not a distributed tenant quota or revocation
 * cache. Native model and GitHub requests never use this function. */
export async function executeEgressRequest(input: EgressHttpRequest, expected: Pick<EgressCapabilityBinding, 'runId'>,
  options: EgressHttpOptions = {}): Promise<EgressHttpResponse> {
  if (!expected?.runId || !input || typeof input !== 'object') throw egressError('invalid_request')
  const now = options.now ?? Date.now
  const claims = openEgressCapability(input.capability, expected, now(), options.env)
  const target = requestTarget(claims, input)
  if (activeRequests >= MAX_CONCURRENT_REQUESTS) throw egressError('limit_exceeded')
  activeRequests++
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), Math.min(EGRESS_TIMEOUT_MS, claims.expiresAt - now()))
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  try {
    const hostname = target.url.hostname.replace(/^\[|\]$/g, '')
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }]
      : await untilAborted(() => (options.resolve ?? (host => lookup(host, { all: true })))(hostname), signal)
    if (!addresses.length || addresses.length > 32 || addresses.some(row => row.family !== isIP(row.address) || !isPublicEgressAddress(row.address)))
      throw egressError('destination_denied')
    if (claims.expiresAt <= now()) throw egressError('expired_capability')
    const address = addresses.find(row => row.family === 4) ?? addresses[0]
    const response = await untilAborted(() => (options.transport ?? transport)({ ...target, address }, signal), signal)
    signal.throwIfAborted()
    if (claims.expiresAt <= now()) throw egressError('expired_capability')
    const result = checkedResponse(response, claims)
    signal.throwIfAborted()
    if (claims.expiresAt <= now()) throw egressError('expired_capability')
    return result
  } catch (cause) {
    if (cause instanceof CodedError && cause.code === 'task_secret_unavailable') throw cause
    throw egressError('upstream_unavailable', cause)
  } finally { clearTimeout(deadline); activeRequests-- }
}
