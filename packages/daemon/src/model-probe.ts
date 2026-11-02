// The models each harness CLI offers, asked of the CLI itself (Alex, 2026-11-02:
// model lists come only from what a CLI or the daemon reported, never from a
// list written here):
// - Codex: its app-server's `model/list` (JSON-RPC over stdio), the catalogue
//   Codex's own model picker shows, with the entry it marks `isDefault`.
// - Claude Code: the `models` of its stream-json `initialize` control response,
//   the list its SDK exposes as `supportedModels()`; each `value` is a model
//   alias (slot) the CLI accepts, `resolvedModel` what it maps to, and the
//   entry whose value is Claude Code's own `default` alias is its default.
// Each probe runs the daemon's pinned binary in a throwaway home, like a run
// (agents/harness-home.ts): the person's own ~/.codex and ~/.claude are never
// read, no task runs, and the home is removed afterwards.
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"

import type { HarnessInfo } from "@mikka/protocol"

/** What a probe adds to a harness's report (`@mikka/protocol` harnessInfoSchema). */
export type ModelReport = Pick<HarnessInfo, "models" | "modelSlots" | "defaultModelSlot">

const MAX = 500
const text = (value: unknown, max: number) => typeof value === "string" && value.trim() && value.trim().length <= max ? value.trim() : null

function report(slots: { slot: string; model: string; name: string }[], defaultSlot: string | null): ModelReport | null {
  const seen = new Set<string>()
  // The protocol refuses an `auto` slot (#537); nothing else is filtered by name.
  const unique = slots.filter(slot => slot.slot !== "auto" && !seen.has(slot.slot) && seen.add(slot.slot)).slice(0, MAX)
  if (!unique.length) return null
  return {
    models: unique.map(slot => slot.slot),
    modelSlots: unique,
    ...(defaultSlot && unique.some(slot => slot.slot === defaultSlot) ? { defaultModelSlot: defaultSlot } : {}),
  }
}

/** Codex app-server `model/list` result: `{ data: Model[] }`. Hidden models stay out, as in Codex's own picker. */
export function parseCodexModelList(result: unknown): ModelReport | null {
  const data = (result as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return null
  const slots: { slot: string; model: string; name: string }[] = []
  let defaultSlot: string | null = null
  for (const entry of data as Record<string, unknown>[]) {
    if (!entry || entry.hidden === true) continue
    const slot = text(entry.id, 128) ?? text(entry.model, 128)
    if (!slot) continue
    slots.push({ slot, model: text(entry.model, 128) ?? slot, name: text(entry.displayName, 200) ?? slot })
    if (entry.isDefault === true && !defaultSlot) defaultSlot = slot
  }
  return report(slots, defaultSlot)
}

/** Claude Code stream-json `initialize` response: `{ models: { value, resolvedModel?, displayName? }[] }`. */
export function parseClaudeInitialize(response: unknown): ModelReport | null {
  const models = (response as { models?: unknown } | null)?.models
  if (!Array.isArray(models)) return null
  const slots: { slot: string; model: string; name: string }[] = []
  for (const entry of models as Record<string, unknown>[]) {
    const slot = text(entry?.value, 128)
    if (!slot) continue
    slots.push({ slot, model: text(entry.resolvedModel, 128) ?? slot, name: text(entry.displayName, 200) ?? slot })
  }
  // Claude Code lists its own default as the alias `default` (its `--model default`).
  return report(slots, slots.some(slot => slot.slot === "default") ? "default" : null)
}

export type ProbedHarness = "codex" | "claude_code"
export interface ProbeOptions {
  /** Where the throwaway home is made; the daemon's data dir. */
  scratchDir: string
  timeoutMs?: number
  spawnImpl?: typeof spawn
}

/** Ask one harness CLI for its models. Null when it does not answer in time or answers nothing usable. */
export async function probeHarnessModels(harness: ProbedHarness, binary: string, options: ProbeOptions): Promise<ModelReport | null> {
  const home = mkdtempSync(join(options.scratchDir, "model-probe-"))
  try {
    return await exchange(harness, binary, home, options)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

function exchange(harness: ProbedHarness, binary: string, home: string, options: ProbeOptions): Promise<ModelReport | null> {
  const args = harness === "codex" ? ["app-server"] : ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]
  // Only what the CLI needs to start: no credentials, no person's config.
  const env = { PATH: process.env.PATH ?? "", HOME: home, CODEX_HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), LANG: process.env.LANG ?? "C.UTF-8" }
  return new Promise(resolve => {
    const child = (options.spawnImpl ?? spawn)(binary, args, { env, cwd: home, stdio: ["pipe", "pipe", "ignore"] })
    let settled = false
    const finish = (value: ModelReport | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout?.removeAllListeners("data")
      child.kill("SIGKILL")
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), options.timeoutMs ?? 20_000)
    const send = (message: unknown) => { try { child.stdin?.write(`${JSON.stringify(message)}\n`) } catch { finish(null) } }
    child.on("error", () => finish(null))
    child.on("exit", () => finish(null))
    let buffer = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8")
      if (buffer.length > 4_000_000) return finish(null)
      let newline: number
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        let message: Record<string, unknown>
        try { message = JSON.parse(line) } catch { continue }
        if (harness === "codex") {
          if (message.id === 1) {
            send({ method: "initialized" })
            send({ id: 2, method: "model/list", params: { includeHidden: false } })
          } else if (message.id === 2) finish(message.error ? null : parseCodexModelList(message.result))
        } else if (message.type === "control_response") {
          const body = message.response as { subtype?: string; response?: unknown } | undefined
          finish(body?.subtype === "success" ? parseClaudeInitialize(body.response) : null)
        }
      }
    })
    if (harness === "codex") send({ id: 1, method: "initialize", params: { clientInfo: { name: "mikka-daemon", version: "1" }, capabilities: null } })
    else send({ type: "control_request", request_id: "mikka-model-probe", request: { subtype: "initialize" } })
  })
}
