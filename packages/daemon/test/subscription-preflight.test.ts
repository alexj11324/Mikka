import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CodedError } from "@mikka/protocol/coded-error"
import { NoSandbox } from "../src/agents/sandbox"
import { buildChildEnv } from "../src/env"
import { HARNESS_PINS, harnessBinaryPath, platformKey, type HarnessStore, type ManagedHarness } from "../src/harness-install"
import { createLogger } from "../src/log"
import { Daemon } from "../src/main"
import * as modelProbe from "../src/model-probe"
import { MemoryServer } from "../src/server-link"
import { preflightLocalSubscription } from "../src/subscription-preflight"
import { cleanupTempDirs, tempDir } from "./helpers"

const daemons: Daemon[] = []
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop()
  vi.restoreAllMocks()
  cleanupTempDirs()
})

type FakeOptions = { version?: string; output?: string; exitCode?: number; hang?: boolean }
function fakeCli(harness: ManagedHarness, initial: FakeOptions = {}) {
  const dir = tempDir(), binary = join(dir, "cli.mjs"), record = join(dir, "calls.jsonl")
  const write = (options: FakeOptions = {}) => {
    const version = options.version ?? HARNESS_PINS.harnesses[harness].version
    const output = options.output ?? (harness === "codex" ? `codex-cli ${version}` : `${version} (Claude Code)`)
    writeFileSync(binary, `#!${process.execPath}
import { appendFileSync } from "node:fs"
appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), home: process.env.HOME, cwd: process.cwd(), envNames: Object.keys(process.env), pid: process.pid }) + "\\n")
if (${Boolean(options.hang)}) await new Promise(resolve => setTimeout(resolve, 60000))
process.stdout.write(${JSON.stringify(output)} + "\\n")
process.exit(${options.exitCode ?? 0})
`)
    chmodSync(binary, 0o755)
  }
  write(initial)
  const calls = (): { args: string[]; home: string; cwd: string; envNames: string[]; pid: number }[] =>
    existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").map(line => JSON.parse(line)) : []
  return { binary, record, write, calls }
}

const options = () => ({ store: { root: tempDir() }, scratchDir: tempDir() })

function installFake(store: HarnessStore, harness: ManagedHarness, cli: ReturnType<typeof fakeCli>) {
  const pin = HARNESS_PINS.harnesses[harness], binary = harnessBinaryPath(store, harness), dir = dirname(dirname(binary))
  mkdirSync(dirname(binary), { recursive: true })
  copyFileSync(cli.binary, binary)
  chmodSync(binary, 0o755)
  for (const name of pin.companions ?? []) {
    const companion = join(dirname(binary), name)
    copyFileSync(cli.binary, companion)
    chmodSync(companion, 0o755)
  }
  writeFileSync(join(dir, ".mikka-installed"), `complete-package-v1\n${pin.platforms[platformKey()].integrity}${pin.companions?.length ? `\n${pin.companions.join("\n")}` : ""}`)
  return binary
}

describe("subscription startup preflight", () => {
  it.each(["codex", "claude_code"] as const)("%s checks the child environment, strips dirty parent credentials and uses an empty home", async harness => {
    const cli = fakeCli(harness), config = options()
    const result = await preflightLocalSubscription(harness, { ...config, binary: cli.binary,
      hostEnv: { ...process.env, OPENAI_API_KEY: "fixture-key", ANTHROPIC_API_KEY: "fixture-key", GH_TOKEN: "fixture-token", CLAUDE_CONFIG_DIR: "/fixture/private", NODE_OPTIONS: "--inspect" } })
    expect(result).toEqual({ ready: true, version: HARNESS_PINS.harnesses[harness].version })
    const [call] = cli.calls()
    expect(call.args).toEqual(["--version"])
    expect(call.home.startsWith(config.scratchDir)).toBe(true)
    expect(call.home).not.toBe(process.env.HOME)
    expect(call.cwd).toBe(call.home)
    for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GH_TOKEN", "CLAUDE_CONFIG_DIR", "NODE_OPTIONS"]) expect(call.envNames).not.toContain(key)
    expect(existsSync(call.home)).toBe(false)
    expect(readdirSync(config.scratchDir)).toEqual([])
  })

  it("refuses a contaminated child result before executing any CLI", async () => {
    const cli = fakeCli("codex")
    const result = await preflightLocalSubscription("codex", { ...options(), binary: cli.binary,
      buildEnv: () => ({ ...buildChildEnv(), OPENAI_API_KEY: "fixture-only" }) })
    expect(result).toMatchObject({ ready: false, error: { code: "subscription_local_runtime_unavailable", detail: "env_not_clean" } })
    expect(cli.calls()).toEqual([])
  })

  it("keeps an environment-builder exception as a coded failure without aborting daemon startup", async () => {
    const cli = fakeCli("codex"), cause = new Error("fixture child-environment failure")
    const result = await preflightLocalSubscription("codex", { ...options(), binary: cli.binary,
      buildEnv: () => { throw cause } })
    expect(result).toMatchObject({ ready: false, error: { code: "subscription_local_runtime_unavailable", detail: "env_not_clean" } })
    if (!result.ready) expect(result.error.cause).toBe(cause)
    expect(cli.calls()).toEqual([])
  })

  it("reports a missing override or not-yet-installed managed CLI without downloading anything", async () => {
    const config = options()
    expect(await preflightLocalSubscription("codex", { ...config, binary: join(tempDir(), "missing") })).toMatchObject({ ready: false, error: { detail: "cli_missing" } })
    expect(await preflightLocalSubscription("codex", config)).toMatchObject({ ready: false, error: { detail: "cli_missing" } })
    expect(readdirSync(config.store.root)).toEqual([])
  })

  it.each(["codex", "claude_code"] as const)("%s rejects the wrong version and unrecognized version output", async harness => {
    const cli = fakeCli(harness, { version: "0.0.1" }), config = options()
    expect(await preflightLocalSubscription(harness, { ...config, binary: cli.binary })).toMatchObject({ ready: false, error: { detail: "cli_version_mismatch" } })
    cli.write({ output: `unrelated program ${HARNESS_PINS.harnesses[harness].version}` })
    expect(await preflightLocalSubscription(harness, { ...config, binary: cli.binary })).toMatchObject({ ready: false, error: { detail: "cli_version_mismatch" } })
  })

  it("keeps a safe coded failure for a nonzero exit or timeout and removes the probe home", async () => {
    for (const failure of [{ exitCode: 2 }, { hang: true }]) {
      const cli = fakeCli("codex", failure), config = options()
      const result = await preflightLocalSubscription("codex", { ...config, binary: cli.binary, timeoutMs: 1000 })
      expect(result).toMatchObject({ ready: false, error: { code: "subscription_local_runtime_unavailable", detail: "adapter_start_failed" } })
      if (!result.ready) {
        expect(result.error).toBeInstanceOf(CodedError)
        expect(result.error.cause).toBeInstanceOf(Error)
        expect(result.error.message).toBe("subscription_local_runtime_unavailable (adapter_start_failed)")
      }
      expect(readdirSync(config.scratchDir)).toEqual([])
      for (const call of cli.calls()) expect(() => process.kill(call.pid, 0)).toThrow()
    }
  })

  it("executes the managed binary and checks its actual version and required Codex companion", async () => {
    const config = options(), cli = fakeCli("codex"), pin = HARNESS_PINS.harnesses.codex
    const binary = installFake(config.store, "codex", cli)
    const companion = join(dirname(binary), "codex-code-mode-host")
    expect(await preflightLocalSubscription("codex", config)).toEqual({ ready: true, version: pin.version })
    cli.write({ version: "0.0.1" })
    copyFileSync(cli.binary, binary)
    expect(await preflightLocalSubscription("codex", config)).toMatchObject({ ready: false, error: { detail: "cli_version_mismatch" } })
    rmSync(companion)
    expect(await preflightLocalSubscription("codex", config)).toMatchObject({ ready: false, error: { detail: "cli_missing" } })
  })
})

describe("daemon subscription capability", () => {
  async function daemonFor(binary: string) {
    const link = new MemoryServer().link()
    const lease = vi.fn(async () => { throw new Error("preflight must not acquire a subscription lease") })
    const approval = vi.fn(async () => { throw new Error("preflight must not start a run") })
    link.nativeLease = lease
    link.prepareRunToolApproval = approval
    const daemon = new Daemon({ dataDir: tempDir(), flavor: "dev", link, credential: "fixture", heartbeatMs: 60_000,
      harnesses: [{ harness: "codex", installed: true, version: "unchecked", subscriptionBroker: true, subscriptionPreflight: "env_not_clean" }],
      agentSandbox: new NoSandbox(), harnessBinaries: { codex: binary }, modelProbe: false, log: createLogger({ level: "silent" }) })
    daemons.push(daemon)
    await daemon.start()
    return { daemon, lease, approval }
  }

  it("startup removes an unchecked broker claim when the CLI is missing", async () => {
    const { daemon, lease, approval } = await daemonFor(join(tempDir(), "missing"))
    expect(daemon.status().harnesses[0]).toMatchObject({ installed: true, subscriptionPreflight: "cli_missing", coordinator:false })
    expect(daemon.status().harnesses[0].subscriptionBroker).toBeUndefined()
    expect(lease).not.toHaveBeenCalled()
    expect(approval).not.toHaveBeenCalled()
  })

  it("redetect withdraws a formerly healthy broker and clears the failure after recovery", async () => {
    const cli = fakeCli("codex"), { daemon, lease, approval } = await daemonFor(cli.binary)
    const redetect = () => Reflect.get(daemon, "redetectHarnesses").call(daemon) as Promise<void>
    const codex = () => daemon.status().harnesses.find(info => info.harness === "codex")!
    expect(codex()).toMatchObject({ subscriptionBroker: true, version: HARNESS_PINS.harnesses.codex.version })
    expect(codex().subscriptionPreflight).toBeUndefined()
    cli.write({ version: "0.0.1" })
    await redetect()
    expect(codex().subscriptionBroker).toBeUndefined()
    expect(codex().subscriptionPreflight).toBe("cli_version_mismatch")
    cli.write()
    await redetect()
    expect(codex().subscriptionBroker).toBe(true)
    expect(codex().subscriptionPreflight).toBeUndefined()
    expect(lease).not.toHaveBeenCalled()
    expect(approval).not.toHaveBeenCalled()
    expect(cli.calls()).toHaveLength(3)
  })

  it("a completed background install rechecks the broker without waiting for another heartbeat", async () => {
    const link = new MemoryServer().link()
    link.nativeLease = vi.fn(async () => { throw new Error("no subscription login in preflight") })
    link.prepareRunToolApproval = vi.fn(async () => { throw new Error("no run in preflight") })
    const daemon = new Daemon({ dataDir: tempDir(), flavor: "dev", link, credential: "fixture", heartbeatMs: 60_000,
      agentSandbox: new NoSandbox(), modelProbe: false, log: createLogger({ level: "silent" }) })
    daemons.push(daemon)
    await daemon.start()
    for (const harness of ["codex", "claude_code"] as const) {
      expect(daemon.status().harnesses.find(info => info.harness === harness)?.subscriptionPreflight).toBe("cli_missing")
    }
    const store = Reflect.get(daemon, "harnessStore").call(daemon) as HarnessStore
    const codex = fakeCli("codex"), claude = fakeCli("claude_code")
    installFake(store, "codex", codex)
    installFake(store, "claude_code", claude)
    const probe = vi.spyOn(modelProbe, "probeHarnessModels").mockResolvedValue({ models: ["fixture-model"] })
    await Reflect.get(daemon, "probeModels").call(daemon)
    expect(probe).toHaveBeenCalledTimes(2)
    for (const harness of ["codex", "claude_code"] as const) {
      const report = daemon.status().harnesses.find(info => info.harness === harness)
      expect(report?.subscriptionBroker).toBe(true)
      expect(report?.subscriptionPreflight).toBeUndefined()
    }
    expect([...codex.calls(), ...claude.calls()].map(call => call.args)).toEqual([["--version"], ["--version"]])
    expect(link.nativeLease).not.toHaveBeenCalled()
    expect(link.prepareRunToolApproval).not.toHaveBeenCalled()
  })
})
