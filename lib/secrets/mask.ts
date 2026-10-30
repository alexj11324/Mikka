// Runtime masking (4e2, Tech Lead ②). Pure: no DB, no env. Before agent output, logs or
// transcripts are persisted, every workspace secret value of MASK_MIN_LENGTH+ characters is
// replaced by [secret:NAME], as is its standard (padded) base64 form. Shorter values are left alone
// (saving one returns shortValueNotMasked). Other encodings (url-safe/unpadded base64, URL, hex,
// JSON escapes, decoded Basic/Bearer credentials) are deliberately not matched.
export const MASK_MIN_LENGTH = 8

export interface MaskableSecret { name: string; value: string }
export type Masker = ((text: string) => string) & {
  /** Characters at the end of already-masked text that could still be the start of a secret form; a stream holds these back. */
  holdback?: (text: string) => number
}

export const identityMasker: Masker = text => text

const forms = (value: string) => [value, Buffer.from(value, 'utf8').toString('base64')]

/** Builds a masker. Longer needles replace first so a secret containing another is masked whole. */
export function createSecretMasker(secrets: readonly MaskableSecret[]): Masker {
  const needles = new Map<string, string>()
  for (const { name, value } of secrets) {
    if ([...value].length < MASK_MIN_LENGTH) continue
    for (const form of forms(value)) if (!needles.has(form)) needles.set(form, `[secret:${name}]`)
  }
  if (!needles.size) return identityMasker
  const ordered = [...needles.entries()].sort((a, b) => b[0].length - a[0].length)
  const mask: Masker = text => {
    if (typeof text !== 'string' || !text) return text
    let out = text
    for (const [needle, label] of ordered) if (out.includes(needle)) out = out.split(needle).join(label)
    return out
  }
  mask.holdback = text => {
    let hold = 0
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
