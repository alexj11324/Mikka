// Runtime masking (4e2, Tech Lead ②). Pure: no DB, no env. Before agent output, logs or
// transcripts are persisted, every workspace secret value of MASK_MIN_LENGTH+ characters is
// replaced by [secret:NAME], as is its standard (padded) base64 form. Shorter values are left alone
// (saving one returns shortValueNotMasked). Other encodings (url-safe/unpadded base64, URL, hex,
// JSON escapes, decoded Basic/Bearer credentials) are deliberately not matched.
import { maskTaskSecretCapabilities, taskSecretCapabilityHoldback } from '@mikka/protocol/task-secrets'

export const MASK_MIN_LENGTH = 8
// Bump when the matching rules (including task capabilities) change. Retained
// source fragments cannot prove safety against a new rule without full blobs.
export const MASK_RULES_VERSION = 1

export interface MaskableSecret { name: string; value: string }
export type Masker = ((text: string) => string) & {
  /** Server-only, keyed fingerprint of the exact rules and saved values. */
  sourcePolicy?: string
  /** Characters at the end of already-masked text that could still be the start of a secret form; a stream holds these back. */
  holdback?: (text: string) => number
  /** Characters at the end of raw text that could still grow into a credential; a stream holds these back unmasked, in memory, until they end. */
  rawHoldback?: (text: string) => number
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
  const raw = pending + delta
  // A credential pattern matches a growing token early: keep its raw end back until the token ends.
  const rawHold = final ? 0 : (mask.rawHoldback?.(raw) ?? 0)
  const tail = raw.slice(raw.length - rawHold)
  const masked = mask(raw.slice(0, raw.length - rawHold))
  if (final || !mask.holdback) return { release: masked, pending: tail }
  const hold = mask.holdback(masked)
  return { release: masked.slice(0, masked.length - hold), pending: masked.slice(masked.length - hold) + tail }
}

// Credentials Mikka issues or a CLI prints that are not saved workspace secrets: GitHub tokens
// (classic, fine-grained, and installation tokens of the form ghs_<id>_<JWT>, whose `_`s defeat
// gh's own "mask after the last underscore") and JWTs. Each match is masked whole.
const CREDENTIAL_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9_.-]{16,}|github_pat_[A-Za-z0-9_]{20,})/g, '[secret:github-token]'],
  [/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/g, '[secret:jwt]'],
]
const CREDENTIAL_STARTS = ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', 'eyJ']
/** The longest token-shaped end of a stream part is held back at most this far. */
const CREDENTIAL_HOLDBACK_MAX = 4096

/** Replaces every credential pattern match whole: with its `[secret:…]` label, or with `replacement` when given. */
export function maskCredentials(text: string, replacement?: string) {
  let out = maskTaskSecretCapabilities(text, replacement)
  for (const [pattern, label] of CREDENTIAL_PATTERNS) out = out.replace(pattern, replacement ?? label)
  return out
}
/** Credential patterns only, for text no workspace secret list applies to (Coordinator chat and memory). */
export const credentialMasker: Masker = text => (typeof text !== 'string' || !text ? text : maskCredentials(text))

/** Characters at the end of `text` that could still grow into a credential with the next delta. */
const credentialHoldback = (text: string) => {
  let startOfTail = text.length
  while (startOfTail > 0 && /[A-Za-z0-9_.-]/.test(text[startOfTail - 1])) startOfTail--
  const tail = text.slice(startOfTail)
  if (!tail) return 0
  let hold = 0
  for (const prefix of CREDENTIAL_STARTS) {
    const start = tail.indexOf(prefix)
    if (start >= 0) hold = Math.max(hold, Math.min(tail.length - start, CREDENTIAL_HOLDBACK_MAX))
    for (let length = Math.min(prefix.length - 1, tail.length); length > hold; length--) {
      if (prefix.startsWith(tail.slice(-length))) { hold = length; break }
    }
  }
  return hold
}

/** `mask`, then credential patterns: what persisted run output always gets, with or without saved secrets. */
export function withCredentialMasking(mask: Masker): Masker {
  const masked: Masker = text => (typeof text !== 'string' || !text ? text : maskCredentials(mask(text)))
  if (mask.holdback) masked.holdback = mask.holdback
  masked.rawHoldback = text => Math.max(credentialHoldback(text), taskSecretCapabilityHoldback(text))
  return masked
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
