// Runtime masking (4e2, Tech Lead ②). Pure: no DB, no env. Before agent output, logs or
// transcripts are persisted, every workspace secret value of MASK_MIN_LENGTH+ characters is
// replaced by [secret:NAME], including its base64 (standard and url-safe, padded or not) and
// URL-encoded, hex (lowercase) and JSON-escaped forms, and an HTTP `Basic`/`Bearer` token whose
// base64 decodes to text containing the value. Shorter values are left alone (saving one returns
// shortValueNotMasked). Known limitations: uppercase hex and base64 at a non-zero byte offset inside a
// longer base64 blob are not matched.
export const MASK_MIN_LENGTH = 8

export interface MaskableSecret { name: string; value: string }
export type Masker = ((text: string) => string) & {
  /** Characters at the end of already-masked text that could still be the start of a secret form; a stream holds these back. */
  holdback?: (text: string) => number
}

export const identityMasker: Masker = text => text

const AUTH_TOKEN = /\b(Basic|Bearer)(\s+)([A-Za-z0-9+/_-]+={0,2})/gi
const AUTH_TAIL = /\b(?:Basic|Bearer)\s+(?:[A-Za-z0-9+/_=-]|\[secret:[^\]\s]*\]?)*$|\b(?:Basic|Bearer)\s*$/i
// A streamed token masked before its padding arrived: drop the late '='.
const AUTH_LABEL_PADDING = /\b(Basic|Bearer)(\s+)(\[secret:[^\]\s]+\])=+/gi
const AUTH_WORDS = ['basic ', 'bearer ']

function decodeBase64(token: string): string | null {
  try {
    const text = Buffer.from(token.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8')
    return text.includes('\uFFFD') ? null : text
  } catch { return null }
}

function forms(value: string): string[] {
  const b64 = Buffer.from(value, 'utf8').toString('base64')
  const unpadded = b64.replace(/=+$/, '')
  const urlSafe = unpadded.replaceAll('+', '-').replaceAll('/', '_')
  const hex = Buffer.from(value, 'utf8').toString('hex')
  const json = JSON.stringify(value).slice(1, -1)
  return [value, b64, unpadded, urlSafe, encodeURIComponent(value), encodeURI(value), new URLSearchParams({ v: value }).toString().slice(2), hex, json, JSON.stringify(json).slice(1, -1)]
}

/** Builds a masker. Longer needles replace first so a secret containing another is masked whole. */
export function createSecretMasker(secrets: readonly MaskableSecret[]): Masker {
  const needles = new Map<string, string>()
  const raw: Array<[string, string]> = []
  for (const { name, value } of secrets) {
    if ([...value].length < MASK_MIN_LENGTH) continue
    raw.push([value, `[secret:${name}]`])
    for (const form of forms(value)) if (form.length >= MASK_MIN_LENGTH && !needles.has(form)) needles.set(form, `[secret:${name}]`)
  }
  if (!needles.size) return identityMasker
  const ordered = [...needles.entries()].sort((a, b) => b[0].length - a[0].length)
  raw.sort((a, b) => b[0].length - a[0].length)
  const mask: Masker = text => {
    if (typeof text !== 'string' || !text) return text
    // Basic/Bearer first: the decoded credential (user:pass, a JWT…) contains the value.
    let out = text.replace(AUTH_TOKEN, (whole, scheme: string, space: string, token: string) => {
      const decoded = decodeBase64(token)
      const hit = decoded && raw.find(([value]) => decoded.includes(value))
      return hit ? `${scheme}${space}${hit[1]}` : whole
    }).replace(AUTH_LABEL_PADDING, '$1$2$3')
    for (const [needle, label] of ordered) if (out.includes(needle)) out = out.split(needle).join(label)
    return out
  }
  mask.holdback = text => {
    let hold = 0
    const lower = text.slice(-16).toLowerCase()
    for (const word of AUTH_WORDS) for (let k = Math.min(word.length, lower.length); k > hold; k--) if (lower.endsWith(word.slice(0, k))) { hold = k; break }
    const auth = AUTH_TAIL.exec(text)
    if (auth) hold = Math.max(hold, text.length - auth.index)
    for (const [needle] of ordered) {
      for (let k = Math.min(needle.length - 1, text.length); k > hold; k--) if (text.endsWith(needle.slice(0, k))) { hold = k; break }
    }
    return hold
  }
  return mask
}

/**
 * One streamed part (text/reasoning deltas arrive token by token): `pending` is the raw text held
 * back from earlier deltas. The whole buffer is masked; everything but a possible secret start is
 * released. `final` (part or run ended) releases the rest, masked.
 */
export function maskStreamStep(mask: Masker, pending: string, delta: string, final = false): { release: string; pending: string } {
  const masked = mask(pending + delta)
  if (final || !mask.holdback) return { release: masked, pending: '' }
  const hold = mask.holdback(masked)
  return { release: masked.slice(0, masked.length - hold), pending: masked.slice(masked.length - hold) }
}

/** Applies the masker to every string (values and object keys) in a JSON-like value. */
export function maskDeep<T>(value: T, mask: Masker): T {
  if (mask === identityMasker) return value
  const walk = (input: unknown): unknown => {
    if (typeof input === 'string') return mask(input)
    if (Array.isArray(input)) return input.map(walk)
    if (input && typeof input === 'object' && Object.getPrototypeOf(input) === Object.prototype)
      return Object.fromEntries(Object.entries(input).map(([k, v]) => [mask(k), walk(v)]))
    return input
  }
  return walk(value) as T
}
