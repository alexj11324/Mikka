// Detects which harness CLIs are installed on this device, their versions
// and the models each offers; reported on device registration and
// heartbeats. The model lists and permission modes come from the CLIs
// themselves, so the server never offers a model, effort level or
// permission mode a harness would not take.
import { query } from "@anthropic-ai/claude-agent-sdk"
import type { Harness, HarnessInfo, HarnessModel } from "@mikka/protocol"
import { execa } from "execa"

import { buildChildEnv } from "./env"
import { DAEMON_VERSION } from "./paths"

/** Candidate binaries per harness, tried in order. */
export const HARNESS_BINARIES: Record<Exclude<Harness, "mock">, string[]> = {
  claude_code: ["claude"],
  codex: ["codex"],
  cursor: ["cursor-agent", "agent"],
}

async function versionOf(binary: string): Promise<string | null> {
  try {
    const { stdout } = await execa(binary, ["--version"], {
      env: buildChildEnv(),
      extendEnv: false,
      timeout: 5_000,
      stdin: "ignore",
    })
    const line = stdout.trim().split("\n")[0]?.trim()
    return line || null
  } catch {
    return null
  }
}

/** How long a CLI gets to list its models before detection goes on without. */
const MODEL_LIST_TIMEOUT_MS = 20_000

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms)
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

/** Claude Code: the Agent SDK's own model list, without sending a prompt. */
async function claudeModels(): Promise<HarnessModel[]> {
  async function* idle(): AsyncGenerator<never> {
    await new Promise(() => {})
  }
  const session = query({
    prompt: idle(),
    options: {
      settingSources: [],
      persistSession: false,
      env: buildChildEnv(),
    },
  })
  try {
    const models = await withTimeout(
      session.supportedModels(),
      MODEL_LIST_TIMEOUT_MS
    )
    return models.map((model) => ({
      value: model.value,
      displayName: model.displayName,
      efforts:
        model.supportsEffort === false
          ? []
          : [...(model.supportedEffortLevels ?? [])],
    }))
  } finally {
    session.close()
  }
}

interface CodexModelList {
  data?: {
    id?: string
    model?: string
    displayName?: string
    supportedReasoningEfforts?: { reasoningEffort?: string }[]
  }[]
}

/** Codex: `model/list` on a short-lived `codex app-server`. */
async function codexModels(binary: string): Promise<HarnessModel[]> {
  const child = execa(binary, ["app-server"], {
    env: buildChildEnv(),
    extendEnv: false,
    stdin: "pipe",
    stderr: "ignore",
    reject: false,
  })
  try {
    const answer = new Promise<CodexModelList>((resolve, reject) => {
      let buffer = ""
      child.stdout?.on("data", (data: Buffer) => {
        buffer += data.toString("utf8")
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          let message: {
            id?: number
            result?: CodexModelList
            error?: { message?: string }
          }
          try {
            message = JSON.parse(line)
          } catch {
            continue // a log line, not JSON-RPC
          }
          if (message.id !== 2) continue
          if (message.error)
            reject(new Error(message.error.message ?? "model/list failed"))
          else resolve(message.result ?? {})
        }
      })
      void child.then(() => reject(new Error("codex app-server exited")))
    })
    const send = (message: object) =>
      child.stdin?.write(`${JSON.stringify(message)}\n`)
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "mikka", title: "Mikka", version: DAEMON_VERSION },
        capabilities: null,
      },
    })
    send({ jsonrpc: "2.0", method: "initialized" })
    send({ jsonrpc: "2.0", id: 2, method: "model/list", params: {} })
    const result = await withTimeout(answer, MODEL_LIST_TIMEOUT_MS)
    return (result.data ?? []).flatMap((model) => {
      const value = model.model ?? model.id
      if (!value) return []
      const efforts = (model.supportedReasoningEfforts ?? []).flatMap(
        (option) => (option.reasoningEffort ? [option.reasoningEffort] : [])
      )
      return [{ value, displayName: model.displayName ?? value, efforts }]
    })
  } finally {
    child.kill()
  }
}

/** The flag each CLI takes its permission mode with. */
const PERMISSION_FLAGS: Partial<Record<Exclude<Harness, "mock">, string>> = {
  claude_code: "--permission-mode",
  codex: "--ask-for-approval",
}

/**
 * The values a flag takes, read from a CLI's `--help`: commander's
 * `(choices: "a", "b")` (Claude Code), clap's `[possible values: a, b]`, or
 * clap's long form with one `- value: description` line per value (Codex).
 */
export function flagChoices(help: string, flag: string): string[] {
  const lines = help.split("\n")
  // The flag's own line, not a description that mentions it.
  const start = lines.findIndex((line) =>
    new RegExp(`^\\s*(-[A-Za-z], )?${flag}([\\s=<]|$)`).test(line)
  )
  if (start === -1) return []
  const indent = lines[start]!.search(/\S/)
  const block = [lines[start]!]
  for (const line of lines.slice(start + 1)) {
    // The next option starts at the flag's own indentation.
    if (/^\s*-/.test(line) && line.search(/\S/) <= indent) break
    block.push(line)
  }
  const text = block.join("\n")
  const commander = /\(choices:\s*([^)]*)\)/.exec(text)
  if (commander)
    return [...commander[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!)
  const short = /\[possible values:\s*([^\]]*)\]/.exec(text)
  if (short)
    return short[1]!
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  const long = text.split(/Possible values:\s*\n/)[1]
  if (!long) return []
  return [...long.matchAll(/^\s*-\s*([A-Za-z0-9_-]+)\s*:/gm)].map(
    (match) => match[1]!
  )
}

/** The permission modes an installed CLI lists in its help; undefined when it could not be read. */
async function permissionModesOf(
  harness: Exclude<Harness, "mock">,
  binary: string
): Promise<string[] | undefined> {
  const flag = PERMISSION_FLAGS[harness]
  if (!flag) return undefined
  try {
    const { stdout } = await execa(binary, ["--help"], {
      env: buildChildEnv(),
      extendEnv: false,
      timeout: 5_000,
      stdin: "ignore",
    })
    const modes = flagChoices(stdout, flag)
    return modes.length ? modes : undefined
  } catch {
    return undefined
  }
}

/** The models an installed CLI offers; undefined when it could not be asked. */
async function modelsOf(
  harness: Exclude<Harness, "mock">,
  binary: string
): Promise<HarnessModel[] | undefined> {
  try {
    if (harness === "claude_code") return await claudeModels()
    if (harness === "codex") return await codexModels(binary)
    return undefined
  } catch {
    return undefined
  }
}

export async function detectHarnesses(): Promise<HarnessInfo[]> {
  const detected = await Promise.all(
    (Object.keys(HARNESS_BINARIES) as Exclude<Harness, "mock">[]).map(
      async (harness): Promise<HarnessInfo> => {
        for (const binary of HARNESS_BINARIES[harness]) {
          const version = await versionOf(binary)
          if (!version) continue
          const [models, permissionModes] = await Promise.all([
            modelsOf(harness, binary),
            permissionModesOf(harness, binary),
          ])
          return {
            harness,
            installed: true,
            version,
            ...(models?.length ? { models } : {}),
            ...(permissionModes ? { permissionModes } : {}),
          }
        }
        return { harness, installed: false, version: null }
      }
    )
  )
  return [
    ...detected,
    { harness: "mock", installed: true, version: DAEMON_VERSION },
  ]
}
