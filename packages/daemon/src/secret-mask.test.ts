import { gunzipSync, gzipSync } from "node:zlib"
import { describe, expect, it } from "vitest"

import type { RunChunk } from "./chunks"
import { createRunMasker, MASK_MIN_LENGTH } from "./secret-mask"

const SECRET = "sk_live_0123456789abcdef"
const OTHER = "ghp_ABCDEFGHIJKLMNOP"
const b64 = (value: string) => Buffer.from(value).toString("base64")
const masker = () => createRunMasker([{ name: "A", value: SECRET }, { name: "B", value: OTHER }])!

type Chunk = Record<string, unknown>
const delta = (text: string, id = "p1"): RunChunk => ({ type: "text-delta", id, delta: text }) as RunChunk
const joined = (chunks: RunChunk[], type = "text-delta", field = "delta") =>
  (chunks as unknown as Chunk[]).filter((c) => c.type === type).map((c) => c[field] as string).join("")

/**
 * Feeds `pieces` as single-delta outbox batches (each `chunk()` call's output is what the outbox
 * persists and may upload right away) and checks no released chunk carries a secret start.
 */
function stream(pieces: string[], end: RunChunk | null, m = masker()) {
  const released: RunChunk[] = []
  for (const piece of pieces) {
    const out = m.chunk(delta(piece))
    for (const chunk of out) expect(JSON.stringify(chunk)).not.toMatch(/sk_live_0123|ghp_ABCDEFGH|c2tfbGl2ZV8wMTIz/)
    released.push(...out)
  }
  released.push(...(end ? m.chunk(end) : m.flush()))
  return released
}

describe("daemon secret masking (before upload)", () => {
  it("no secrets (or only short ones) means no masker: output is untouched", () => {
    expect(createRunMasker([])).toBeNull()
    expect(createRunMasker([{ name: "S", value: "1234567" }])).toBeNull()
    expect(MASK_MIN_LENGTH).toBe(8)
  })

  it("masks the raw value and its standard base64, nothing else", () => {
    const m = masker()
    expect(m.text(`a ${SECRET} b ${b64(SECRET)} c ${OTHER}`)).toBe("a [secret:A] b [secret:A] c [secret:B]")
    const odd = "pa?ss/wo+rd&123"
    const o = createRunMasker([{ name: "P", value: odd }])!
    for (const form of [encodeURIComponent(odd), Buffer.from(odd).toString("hex"), Buffer.from(odd).toString("base64url")])
      expect(o.text(form)).toBe(form)
  })

  it("a secret split between two batches is masked before either half leaves, at every offset", () => {
    for (const value of [SECRET, b64(SECRET), OTHER]) {
      const text = `before ${value} after`
      for (let cut = 1; cut < text.length; cut++) {
        const out = stream([text.slice(0, cut), text.slice(cut)], { type: "text-end", id: "p1" } as RunChunk)
        expect(joined(out)).toBe(masker().text(text))
        expect((out.at(-1) as unknown as Chunk).type).toBe("text-end")
      }
    }
  })

  it("character-by-character deltas, multiple secrets back to back", () => {
    const text = `${SECRET}${OTHER} and ${b64(OTHER)}.`
    const out = stream([...text], { type: "finish" } as RunChunk)
    expect(joined(out)).toBe("[secret:A][secret:B] and [secret:B].")
  })

  it("overlapping secrets: the longer one wins whole, the shorter is masked alone", () => {
    const m = createRunMasker([{ name: "SHORT", value: "abcdefgh" }, { name: "LONG", value: "abcdefgh-ijkl" }])!
    const out = stream([..."abcdefgh-ijkl abcdefgh"], null, m)
    expect(joined(out)).toBe("[secret:LONG] [secret:SHORT]")
  })

  it("held text is released at part end, run end and stop (flush)", () => {
    for (const end of [{ type: "text-end", id: "p1" }, { type: "finish" }, { type: "error", errorText: "x" }, { type: "abort" }, null]) {
      const out = stream(["ends with sk_live_0"], end as RunChunk | null)
      expect(joined(out)).toBe("ends with sk_live_0")
    }
  })

  it("parts are held independently; tool input deltas too", () => {
    const m = masker()
    const out = [
      ...m.chunk(delta("x sk_live_0123", "a")),
      ...m.chunk({ type: "reasoning-delta", id: "b", delta: "y sk_live_" } as RunChunk),
      ...m.chunk({ type: "tool-input-delta", toolCallId: "c", inputTextDelta: `{"k":"${SECRET.slice(0, 5)}` } as RunChunk),
      ...m.chunk(delta("456789abcdef z", "a")),
      ...m.chunk({ type: "reasoning-delta", id: "b", delta: "0123456789abcdef" } as RunChunk),
      ...m.chunk({ type: "tool-input-delta", toolCallId: "c", inputTextDelta: `${SECRET.slice(5)}"}` } as RunChunk),
      ...m.flush(),
    ]
    expect(joined(out.filter((c) => (c as unknown as Chunk).id === "a"))).toBe("x [secret:A] z")
    expect(joined(out, "reasoning-delta")).toBe("y [secret:A]")
    expect(joined(out, "tool-input-delta", "inputTextDelta")).toBe('{"k":"[secret:A]"}')
  })

  it("whole chunks, run patches and completions are masked deep (values and keys)", () => {
    const m = masker()
    expect(m.chunk({ type: "data-run-state", data: { state: "failed", error: `boom ${SECRET}` } } as RunChunk)).toEqual([{ type: "data-run-state", data: { state: "failed", error: "boom [secret:A]" } }])
    expect(m.deep({ kind: "complete", completion: { report: { summary: `used ${OTHER}`, openQuestions: [SECRET] } } })).toEqual({ kind: "complete", completion: { report: { summary: "used [secret:B]", openQuestions: ["[secret:A]"] } } })
  })

  it("checkpoints: gzipped and plain patches are masked; binary left; a bad gzip throws (never uploaded unmasked)", () => {
    const m = masker()
    const diff = `+++ b/.env\n+API_TOKEN=${SECRET}\n`
    const cp = { baseCommit: "a".repeat(40), patch: gzipSync(diff).toString("base64"), files: 1, takenAt: new Date().toISOString() }
    expect(gunzipSync(Buffer.from(m.checkpoint(cp).patch, "base64")).toString()).toBe("+++ b/.env\n+API_TOKEN=[secret:A]\n")
    expect(Buffer.from(m.checkpoint({ ...cp, patch: Buffer.from(diff).toString("base64") }).patch, "base64").toString()).toContain("[secret:A]")
    const binary = { ...cp, patch: Buffer.from([0xff, 0xfe, ...Buffer.from(SECRET)]).toString("base64") }
    expect(m.checkpoint(binary)).toBe(binary)
    expect(() => m.checkpoint({ ...cp, patch: Buffer.from([0x1f, 0x8b, 8, 0, 1, 2]).toString("base64") })).toThrow()
  })

  it("dispose forgets the secrets and anything held", () => {
    const m = masker()
    m.chunk(delta("x sk_live_0"))
    m.dispose()
    expect(m.flush()).toEqual([])
    expect(m.text(SECRET)).toBe(SECRET)
  })
})
