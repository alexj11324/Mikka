import { EnvironmentError } from './database-target.mjs'
import { dockerOrigin } from './docker-target.mjs'

const fail = code => { throw new EnvironmentError(code) }
const TOKEN = /^[!#$%&'*+.^_\x60|~0-9A-Za-z-]+$/

function splitForwarded(value, separator) {
  const parts = []
  let start = 0, quoted = false, escaped = false
  for (let index = 0; index < value.length; index++) {
    const character = value[index]
    if (escaped) { escaped = false; continue }
    if (quoted && character === '\\') { escaped = true; continue }
    if (character === '"') quoted = !quoted
    else if (!quoted && character === separator) { parts.push(value.slice(start, index).trim()); start = index + 1 }
  }
  if (quoted || escaped) fail('DOCKER_INGRESS_FORWARDED_REJECTED')
  parts.push(value.slice(start).trim())
  if (parts.some(part => !part)) fail('DOCKER_INGRESS_FORWARDED_REJECTED')
  return parts
}

function forwardedValue(value) {
  if (TOKEN.test(value)) return value
  if (value.length < 2 || value[0] !== '"' || value.at(-1) !== '"') fail('DOCKER_INGRESS_FORWARDED_REJECTED')
  let decoded = ''
  for (let index = 1; index < value.length - 1; index++) {
    const character = value[index]
    if (character === '"') fail('DOCKER_INGRESS_FORWARDED_REJECTED')
    if (character === '\\') {
      if (++index >= value.length - 1) fail('DOCKER_INGRESS_FORWARDED_REJECTED')
      decoded += value[index]
    } else decoded += character
  }
  if (!decoded) fail('DOCKER_INGRESS_FORWARDED_REJECTED')
  return decoded
}

function consistentForwarded(value, host) {
  for (const element of splitForwarded(value, ',')) {
    const seen = new Set()
    for (const parameter of splitForwarded(element, ';')) {
      const equals = parameter.indexOf('=')
      const name = parameter.slice(0, equals).trim().toLowerCase()
      if (equals < 1 || !TOKEN.test(name) || seen.has(name)) fail('DOCKER_INGRESS_FORWARDED_REJECTED')
      seen.add(name)
      const content = forwardedValue(parameter.slice(equals + 1).trim())
      if ((name === 'host' && content !== host) || (name === 'proto' && content !== 'https')) fail('DOCKER_INGRESS_FORWARDED_REJECTED')
    }
  }
}

/** Pure boundary for the separately attested Docker test server. The caller
 * supplies the immutable descriptor origin, never an origin from a request.
 * Validate IncomingMessage.rawHeaders before using its fixed authority in
 * Next's custom-server options; this function leaves the request unmodified.
 * Node's normalized headers discard duplicate Host fields:
 * https://nodejs.org/api/http.html#messagerawheaders
 * No forwarded header grants trust or changes the selected authority. */
export function dockerRequestUrl(request, origin) {
  const expected = /^https:\/\/3000-([a-z0-9]+)\.sbx\.sandboxes-cloud\.docker\.com$/.exec(origin ?? '')
  if (!expected || dockerOrigin(`sbx_${expected[1]}`, 3000) !== origin) fail('DOCKER_INGRESS_ORIGIN_INVALID')
  const host = origin.slice('https://'.length)
  const raw = request?.rawHeaders
  if (!Array.isArray(raw) || raw.length % 2 || raw.length > 256) fail('DOCKER_INGRESS_HEADERS_INVALID')
  const critical = new Map()
  let bytes = 0
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index], value = raw[index + 1]
    // oxlint-disable-next-line no-control-regex -- Reject header separators/control bytes before parsing the original fields.
    if (typeof name !== 'string' || !TOKEN.test(name) || typeof value !== 'string' || /[\x00-\x08\x0a-\x1f\x7f]/.test(value)) fail('DOCKER_INGRESS_HEADERS_INVALID')
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value)
    if (bytes > 64 * 1024) fail('DOCKER_INGRESS_HEADERS_INVALID')
    const key = name.toLowerCase()
    if (!['host', 'forwarded', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port'].includes(key)) continue
    if (critical.has(key)) fail(key === 'host' ? 'DOCKER_INGRESS_HOST_REJECTED' : 'DOCKER_INGRESS_FORWARDED_REJECTED')
    critical.set(key, value)
  }
  if (critical.get('host') !== host) fail('DOCKER_INGRESS_HOST_REJECTED')
  for (const [key, wanted] of [['x-forwarded-host', host], ['x-forwarded-proto', 'https'], ['x-forwarded-port', '443']]) {
    if (critical.has(key) && critical.get(key) !== wanted) fail('DOCKER_INGRESS_FORWARDED_REJECTED')
  }
  if (critical.has('forwarded')) consistentForwarded(critical.get('forwarded'), host)
  const target = request?.url
  // oxlint-disable-next-line no-control-regex -- An HTTP origin-form target cannot contain controls, whitespace or a fragment.
  if (typeof target !== 'string' || target.length > 16_384 || !target.startsWith('/') || target.startsWith('//') || /[\\#\x00-\x20\x7f]/.test(target)) fail('DOCKER_INGRESS_TARGET_REJECTED')
  let absolute
  try { absolute = new URL(target, origin) } catch { fail('DOCKER_INGRESS_TARGET_REJECTED') }
  if (absolute.origin !== origin || absolute.username || absolute.password || absolute.hash) fail('DOCKER_INGRESS_TARGET_REJECTED')
  return absolute.href
}
