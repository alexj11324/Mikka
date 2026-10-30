// Runtime masking (4e2, Tech Lead ②). Pure: no DB, no env. Before agent output, logs or
// transcripts are persisted, every workspace secret value of MASK_MIN_LENGTH+ characters is
// replaced by [secret:NAME], including its base64 (standard and url-safe, padded or not) and
// URL-encoded forms. Shorter values are left alone (saving one returns shortValueNotMasked).
export const MASK_MIN_LENGTH = 8

export interface MaskableSecret { name: string; value: string }
export type Masker = (text: string) => string

export const identityMasker: Masker = text => text

function forms(value: string): string[] {
  const b64 = Buffer.from(value, 'utf8').toString('base64')
  const unpadded = b64.replace(/=+$/, '')
  const urlSafe = unpadded.replaceAll('+', '-').replaceAll('/', '_')
  return [value, b64, unpadded, urlSafe, encodeURIComponent(value), encodeURI(value), new URLSearchParams({ v: value }).toString().slice(2)]
}

/** Builds a masker. Longer needles replace first so a secret containing another is masked whole. */
export function createSecretMasker(secrets: readonly MaskableSecret[]): Masker {
  const needles = new Map<string, string>()
  for (const { name, value } of secrets) {
    if ([...value].length < MASK_MIN_LENGTH) continue
    for (const form of forms(value)) if (form.length >= MASK_MIN_LENGTH && !needles.has(form)) needles.set(form, `[secret:${name}]`)
  }
  if (!needles.size) return identityMasker
  const ordered = [...needles.entries()].sort((a, b) => b[0].length - a[0].length)
  return text => {
    if (typeof text !== 'string' || !text) return text
    let out = text
    for (const [needle, label] of ordered) if (out.includes(needle)) out = out.split(needle).join(label)
    return out
  }
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
