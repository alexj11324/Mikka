// Masks a run's injected workspace secrets in the daemon, before anything is written to the outbox
// or sent (like the GitHub Actions runner). The server masks again as a second layer (lib/secrets).
// Forms: the raw value and its standard (padded) base64, each replaced by `[secret:NAME]` as the
// server does. Values shorter than MASK_MIN_LENGTH code points are left alone (the server warns on save).
//
// Streamed text arrives token by token, so per streamed part the masker holds back, in memory only,
// the raw end of the text that could still be the start of a secret form (at most the longest form
// minus one character, plus any complete shorter form that a longer one could still extend), and
// releases it, masked, with the next delta of that part, at the part's end, or at the run's end. A secret split between two outbox
// batches is therefore masked before either half leaves the machine. Secret values are never logged
// or written anywhere; `dispose()` drops them when the run ends.
import { gunzipSync, gzipSync } from "node:zlib"

import type { RunCheckpoint } from "@mikka/protocol"

import type { RunChunk } from "./chunks"

export const MASK_MIN_LENGTH = 8

type Chunk = Record<string, unknown>

const DELTAS: Record<string, { prefix: string; idField: string; textField: string }> = {
  "text-delta": { prefix: "text", idField: "id", textField: "delta" },
  "reasoning-delta": { prefix: "reasoning", idField: "id", textField: "delta" },
  "tool-input-delta": { prefix: "tool", idField: "toolCallId", textField: "inputTextDelta" },
}
const ENDS: Record<string, { prefix: string; idField: string; deltaType: string }> = {
  "text-end": { prefix: "text", idField: "id", deltaType: "text-delta" },
  "reasoning-end": { prefix: "reasoning", idField: "id", deltaType: "reasoning-delta" },
  "tool-input-available": { prefix: "tool", idField: "toolCallId", deltaType: "tool-input-delta" },
  "tool-input-error": { prefix: "tool", idField: "toolCallId", deltaType: "tool-input-delta" },
}
const RUN_ENDS = new Set(["finish", "error", "abort"])
const DELTA_FOR_PREFIX: Record<string, string> = { text: "text-delta", reasoning: "reasoning-delta", tool: "tool-input-delta" }

/** Inflated-size cap for masking a checkpoint (the wire cap is on the gzipped bytes). */
const CHECKPOINT_MAX_INFLATED = 64 * 1024 * 1024

export interface RunMasker {
  /** Masks one string. */
  text(value: string): string
  /** Masks every string (values and object keys) in a JSON-like value. */
  deep<T>(value: T): T
  /** One chunk in, the chunks to persist out (in order). Holds back a possible secret start per streamed part. */
  chunk(chunk: RunChunk): RunChunk[]
  /** Releases everything held back, masked, as deltas of their parts (run end / stop). */
  flush(): RunChunk[]
  /** Masks the checkpoint's patch (gunzip, mask, gzip). Throws when the patch cannot be inflated. */
  checkpoint(checkpoint: RunCheckpoint): RunCheckpoint
  /** Forgets the secret values and anything held back. */
  dispose(): void
}

/**
 * A masker for one run, or null when nothing needs masking (no secrets, or all shorter than
 * MASK_MIN_LENGTH). Longer forms replace first, so a secret containing another is masked whole.
 */
export function createRunMasker(secrets: ReadonlyArray<{ name: string; value: string }>): RunMasker | null {
  let needles: Array<[string, string]> = []
  const seen = new Set<string>()
  for (const { name, value } of secrets) {
    if (typeof value !== "string" || [...value].length < MASK_MIN_LENGTH) continue
    for (const form of [value, Buffer.from(value, "utf8").toString("base64")]) {
      if (seen.has(form)) continue
      seen.add(form)
      needles.push([form, `[secret:${name}]`])
    }
  }
  if (!needles.length) return null
  needles.sort((a, b) => b[0].length - a[0].length)
  let pending = new Map<string, string>()

  const text = (value: string) => {
    let out = value
    for (const [needle, label] of needles) if (out.includes(needle)) out = out.split(needle).join(label)
    return out
  }
  /** Characters at the end of `value` that are the start of some form (at most the longest form − 1). */
  const holdback = (value: string) => {
    let hold = 0
    for (const [needle] of needles)
      for (let k = Math.min(needle.length - 1, value.length); k > hold; k--)
        if (value.endsWith(needle.slice(0, k))) { hold = k; break }
    return hold
  }
  /**
   * How much of the raw buffer can be released: everything before a tail that could still grow into
   * a form, moved back further so no complete form straddles the cut (a short secret that is also the
   * start of a longer one waits until the longer one is decided).
   */
  const safeCut = (raw: string) => {
    let cut = raw.length - holdback(raw)
    for (let moved = true; moved && cut > 0; ) {
      moved = false
      for (const [needle] of needles) {
        for (let at = raw.indexOf(needle, Math.max(0, cut - needle.length + 1)); at !== -1 && at < cut; at = raw.indexOf(needle, at + 1))
          if (at + needle.length > cut) { cut = at; moved = true }
      }
    }
    return cut
  }
  const deep = <T,>(value: T): T => {
    const walk = (input: unknown): unknown => {
      if (typeof input === "string") return text(input)
      if (Array.isArray(input)) return input.map(walk)
      if (input && typeof input === "object" && Object.getPrototypeOf(input) === Object.prototype)
        return Object.fromEntries(Object.entries(input).map(([k, v]) => [text(k), walk(v)]))
      return input
    }
    return walk(value) as T
  }
  const tail = (key: string): RunChunk | null => {
    const held = pending.get(key)
    pending.delete(key)
    if (!held) return null
    const sep = key.indexOf(":")
    const prefix = key.slice(0, sep), id = key.slice(sep + 1)
    const masked = text(held)
    return (prefix === "tool"
      ? { type: "tool-input-delta", toolCallId: id, inputTextDelta: masked }
      : { type: DELTA_FOR_PREFIX[prefix], id, delta: masked }) as RunChunk
  }
  const flush = () => {
    const out: RunChunk[] = []
    for (const key of Array.from(pending.keys())) { const t = tail(key); if (t) out.push(t) }
    return out
  }

  return {
    text,
    deep,
    flush,
    chunk(input) {
      const chunk = input as unknown as Chunk
      const type = typeof chunk.type === "string" ? chunk.type : ""
      const delta = DELTAS[type]
      if (delta && typeof chunk[delta.idField] === "string" && typeof chunk[delta.textField] === "string") {
        const key = `${delta.prefix}:${chunk[delta.idField] as string}`
        const raw = (pending.get(key) ?? "") + (chunk[delta.textField] as string)
        const cut = safeCut(raw)
        if (cut < raw.length) pending.set(key, raw.slice(cut)); else pending.delete(key)
        return [{ ...deep({ ...chunk, [delta.textField]: "" }), [delta.textField]: text(raw.slice(0, cut)) } as unknown as RunChunk]
      }
      const end = ENDS[type]
      if (end && typeof chunk[end.idField] === "string") {
        const t = tail(`${end.prefix}:${chunk[end.idField] as string}`)
        return [...(t ? [t] : []), deep(input)]
      }
      if (RUN_ENDS.has(type)) return [...flush(), deep(input)]
      return [deep(input)]
    },
    checkpoint(checkpoint) {
      const raw = Buffer.from(checkpoint.patch, "base64")
      const gzipped = raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b
      const body = gzipped ? gunzipSync(raw, { maxOutputLength: CHECKPOINT_MAX_INFLATED }) : raw
      const source = body.toString("utf8")
      // Non-UTF-8 content (git binary hunks are base85) is left as is.
      if (!Buffer.from(source, "utf8").equals(body)) return checkpoint
      const masked = text(source)
      if (masked === source) return checkpoint
      const out = Buffer.from(masked, "utf8")
      return { ...checkpoint, patch: (gzipped ? gzipSync(out) : out).toString("base64") }
    },
    dispose() {
      needles = []
      pending = new Map()
    },
  }
}
