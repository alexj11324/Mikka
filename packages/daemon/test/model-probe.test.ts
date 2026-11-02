// The models each harness CLI offers, asked of the CLI (model-probe.ts), with
// the real answers of the pinned CLIs as fixtures: Codex 0.163.0's app-server
// `model/list` and Claude Code 2.1.309's stream-json `initialize` response,
// both captured with an empty home (no account; the initialize response's
// account and other fields were removed, only `models` kept).
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { NoSandbox } from "../src/agents/sandbox"
import { Daemon } from "../src/main"
import { parseClaudeInitialize, parseCodexModelList, probeHarnessModels, sweepModelProbeHomes } from "../src/model-probe"
import { MemoryServer } from "../src/server-link"
import { cleanupTempDirs, tempDir, waitFor } from "./helpers"

const FIXTURES = resolve(import.meta.dirname, "fixtures")
const codexAnswer = JSON.parse(readFileSync(join(FIXTURES, "codex-0.163.0-model-list.json"), "utf8"))
const claudeAnswer = JSON.parse(readFileSync(join(FIXTURES, "claude-code-2.1.309-initialize.json"), "utf8"))

afterEach(() => cleanupTempDirs())

describe("parsing what the CLIs answer", () => {
  it("Codex: every visible model of model/list, by id, with the one Codex marks default", () => {
    const report = parseCodexModelList(codexAnswer.result)!
    expect(report.models).toEqual(codexAnswer.result.data.filter((m: { hidden: boolean }) => !m.hidden).map((m: { id: string }) => m.id))
    expect(report.modelSlots![0]).toEqual({ slot: "gpt-6.1-sol", model: "gpt-6.1-sol", name: "GPT-6.1-Sol" })
    expect(report.defaultModelSlot).toBe(codexAnswer.result.data.find((m: { isDefault: boolean }) => m.isDefault).id)
  })

  it("Codex: hidden models stay out, and no default is invented when none is marked", () => {
    const data = codexAnswer.result.data.map((m: Record<string, unknown>, index: number) => ({ ...m, isDefault: false, hidden: index > 1 }))
    const report = parseCodexModelList({ data, nextCursor: null })!
    expect(report.models).toEqual(data.slice(0, 2).map((m: { id: string }) => m.id))
    expect(report.defaultModelSlot).toBeUndefined()
  })

  it("Claude Code: each alias it accepts, the model it resolves to, and its own `default` alias as the default", () => {
    const models = claudeAnswer.response.response.models as { value: string; resolvedModel: string; displayName: string }[]
    const report = parseClaudeInitialize(claudeAnswer.response.response)!
    expect(report.models).toEqual(models.map(m => m.value))
    expect(report.modelSlots).toEqual(models.map(m => ({ slot: m.value, model: m.resolvedModel, name: m.displayName })))
    expect(report.defaultModelSlot).toBe("default")
    const withoutDefault = parseClaudeInitialize({ models: models.filter(m => m.value !== "default") })!
    expect(withoutDefault.defaultModelSlot).toBeUndefined()
  })

  it("an answer without models is no report, never a stand-in list", () => {
    for (const answer of [null, {}, { data: [] }, { data: "x" }, { data: [{ hidden: false }] }]) expect(parseCodexModelList(answer)).toBeNull()
    for (const answer of [null, {}, { models: [] }, { models: [{ displayName: "x" }] }]) expect(parseClaudeInitialize(answer)).toBeNull()
  })
})

/** A stand-in CLI that speaks the real protocol with the captured answer, and notes the home it ran in. */
function fakeCli(dir: string, harness: "codex" | "claude_code", options: { silent?: boolean } = {}) {
  const path = join(dir, `fake-${harness}.mjs`)
  const homes = join(dir, `${harness}-homes.log`)
  const answer = harness === "codex" ? codexAnswer : claudeAnswer
  writeFileSync(path, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs"
appendFileSync(${JSON.stringify(homes)}, process.env.HOME + "\\n")
writeFileSync(${JSON.stringify(join(dir, `${harness}.pid`))}, String(process.pid))
writeFileSync(process.env.HOME + "/written-by-cli", "x")
if (${options.silent ? "true" : "false"}) setInterval(() => {}, 1000)
let buffer = ""
process.stdin.on("data", chunk => {
  buffer += chunk
  let i
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1)
    if (${options.silent ? "true" : "false"}) continue
    if (message.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: { userAgent: "fake" } }) + "\\n")
    else if (message.id === 2 && message.method === "model/list") process.stdout.write(JSON.stringify(${JSON.stringify({ ...answer, id: 2 })}) + "\\n")
    else if (message.type === "control_request") process.stdout.write(JSON.stringify(${JSON.stringify(answer)}) + "\\n")
  }
})
`)
  chmodSync(path, 0o755)
  return { path, homes: () => existsSync(homes) ? readFileSync(homes, "utf8").trim().split("\n") : [] }
}

describe("probing a CLI", () => {
  it("runs it in a throwaway home under the scratch dir, never the person's, and removes that home", async () => {
    const dir = tempDir(), scratch = tempDir()
    for (const harness of ["codex", "claude_code"] as const) {
      const cli = fakeCli(dir, harness)
      const report = await probeHarnessModels(harness, cli.path, { scratchDir: scratch })
      expect(report?.defaultModelSlot).toBe(harness === "codex" ? "gpt-6.1-sol" : "default")
      const [home] = cli.homes()
      expect(home.startsWith(scratch)).toBe(true)
      expect(home).not.toBe(process.env.HOME)
      expect(existsSync(home)).toBe(false)
    }
    expect(readdirSync(scratch)).toEqual([])
  })

  it("hands the answer back only once the CLI has exited, so its home is never removed under it", async () => {
    const dir = tempDir(), scratch = tempDir()
    for (const options of [{}, { silent: true }]) {
      const cli = fakeCli(dir, "codex", options)
      await probeHarnessModels("codex", cli.path, { scratchDir: scratch, timeoutMs: 500 })
      const pid = Number(readFileSync(join(dir, "codex.pid"), "utf8"))
      expect(() => process.kill(pid, 0)).toThrow()
      expect(readdirSync(scratch)).toEqual([])
    }
  })

  it("a CLI that exits without answering gives no report", async () => {
    const dir = tempDir(), scratch = tempDir()
    const path = join(dir, "gone.mjs")
    writeFileSync(path, "#!/usr/bin/env node\nprocess.exit(3)\n")
    chmodSync(path, 0o755)
    expect(await probeHarnessModels("claude_code", path, { scratchDir: scratch })).toBeNull()
    expect(await probeHarnessModels("claude_code", join(dir, "missing"), { scratchDir: scratch })).toBeNull()
    expect(readdirSync(scratch)).toEqual([])
  })

  it("at start, removes the probe homes a killed daemon left, and nothing else", () => {
    const scratch = tempDir()
    for (const name of ["model-probe-abc", "model-probe-def/nested", "runs", "keep-model-probe-x"]) mkdirSync(join(scratch, name), { recursive: true })
    sweepModelProbeHomes(scratch)
    expect(readdirSync(scratch).sort()).toEqual(["keep-model-probe-x", "runs"])
    sweepModelProbeHomes(join(scratch, "absent"))
  })

  it("a CLI that never answers gives no report after the timeout", async () => {
    const dir = tempDir(), scratch = tempDir()
    const cli = fakeCli(dir, "codex", { silent: true })
    expect(await probeHarnessModels("codex", cli.path, { scratchDir: scratch, timeoutMs: 500 })).toBeNull()
    expect(readdirSync(scratch)).toEqual([])
  })
})

describe("the device report", () => {
  const daemons: Daemon[] = []
  afterEach(async () => { for (const daemon of daemons.splice(0)) await daemon.stop() })

  it("carries each CLI's models and default to the server, and 重新检测 asks the CLIs again", async () => {
    const dir = tempDir()
    const codex = fakeCli(dir, "codex"), claude = fakeCli(dir, "claude_code")
    const server = new MemoryServer("device-models")
    const link = server.link()
    const commandId = "10000000-0000-4000-8000-000000000002"
    let redetect = false
    const reports: { harnesses: { harness: string; models?: string[]; modelSlots?: { slot: string }[]; defaultModelSlot?: string }[]; completedDeviceCommands?: string[] }[] = []
    const heartbeat = link.heartbeat.bind(link)
    link.heartbeat = async (deviceId, status) => {
      reports.push(status as never)
      const result = await heartbeat(deviceId, status)
      if (redetect) { redetect = false; return { ...result, deviceCommands: [{ id: commandId, kind: "redetect" }] } }
      return result
    }
    const daemon = await new Daemon({
      dataDir: tempDir(), flavor: "dev", link, credential: "cred", heartbeatMs: 50,
      harnesses: [{ harness: "codex", installed: true, version: "fake" }, { harness: "claude_code", installed: true, version: "fake" }],
      agentSandbox: new NoSandbox(), harnessBinaries: { codex: codex.path, claude_code: claude.path }, modelProbe: true,
    }).start()
    daemons.push(daemon)
    await waitFor(() => reports.some(report => report.harnesses.some(info => info.harness === "codex" && info.defaultModelSlot) && report.harnesses.some(info => info.harness === "claude_code" && info.defaultModelSlot)))
    const last = reports.at(-1)!
    const codexInfo = last.harnesses.find(info => info.harness === "codex")!
    const claudeInfo = last.harnesses.find(info => info.harness === "claude_code")!
    expect(codexInfo.models).toEqual(parseCodexModelList(codexAnswer.result)!.models)
    expect(codexInfo.defaultModelSlot).toBe("gpt-6.1-sol")
    expect(claudeInfo.modelSlots?.map(slot => slot.slot)).toEqual(parseClaudeInitialize(claudeAnswer.response.response)!.models)
    expect(claudeInfo.defaultModelSlot).toBe("default")
    const before = codex.homes().length
    redetect = true
    await waitFor(() => reports.some(report => report.completedDeviceCommands?.includes(commandId)))
    expect(codex.homes().length).toBeGreaterThan(before)
  }, 30_000)
})
