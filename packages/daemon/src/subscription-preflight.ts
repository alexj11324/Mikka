import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { execa } from "execa"
import { CodedError } from "@mikka/protocol/coded-error"
import type { SubscriptionPreflightFailure } from "@mikka/protocol/harness"
import { BASE_ENV_ALLOW, buildChildEnv, isDeniedEnvName } from "./env"
import { harnessBinaryPath, harnessInstallState, HARNESS_PINS, type HarnessStore, type ManagedHarness } from "./harness-install"

type Failure = CodedError<"subscription_local_runtime_unavailable", SubscriptionPreflightFailure>
export type SubscriptionPreflightResult = { ready: true; version: string } | { ready: false; error: Failure }
export interface SubscriptionPreflightOptions {
  store: HarnessStore
  scratchDir: string
  /** The same explicit binary override used by the run adapter. */
  binary?: string
  hostEnv?: NodeJS.ProcessEnv
  timeoutMs?: number
  /** Test seam for an accidentally contaminated child-env result. */
  buildEnv?: typeof buildChildEnv
}

const refused = (detail: SubscriptionPreflightFailure, cause?: unknown): SubscriptionPreflightResult => ({
  ready: false, error: new CodedError("subscription_local_runtime_unavailable", { detail, cause }),
})

/** A version-only local check: no provider login, lease, model call or person's CLI config. */
export async function preflightLocalSubscription(harness: ManagedHarness, options: SubscriptionPreflightOptions): Promise<SubscriptionPreflightResult> {
  // A dirty parent is normal: only the environment that will reach the child
  // matters. Check it independently of the builder so a regression fails closed.
  let env: Record<string, string>
  try { env = (options.buildEnv ?? buildChildEnv)({ host: options.hostEnv }) }
  catch (error) { return refused("env_not_clean", error) }
  if (Object.keys(env).some(name => isDeniedEnvName(name) || !(BASE_ENV_ALLOW as readonly string[]).includes(name))) return refused("env_not_clean")
  // Installation stays on the existing background model-probe path. The
  // fingerprint change after installation schedules the existing redetect;
  // startup must not wait for an unbounded registry download to register.
  if (!options.binary && harnessInstallState(options.store, harness).state !== "installed") return refused("cli_missing")
  const binary = options.binary ?? harnessBinaryPath(options.store, harness)
  const expected = (options.store.pins ?? HARNESS_PINS).harnesses[harness].version
  let home: string | undefined
  try {
    home = mkdtempSync(join(options.scratchDir, "subscription-preflight-"))
    const result = await execa(binary, ["--version"], {
      env: { ...env, HOME: home }, extendEnv: false, cwd: home,
      timeout: options.timeoutMs ?? 5_000, killSignal: "SIGKILL", maxBuffer: 16_384, stdin: "ignore",
    })
    const output = result.stdout.trim()
    const version = harness === "codex"
      ? /^codex-cli\s+(\d+\.\d+\.\d+)$/.exec(output)?.[1]
      : /^(\d+\.\d+\.\d+)(?:\s+\(Claude Code\))?$/.exec(output)?.[1]
    return version === expected ? { ready: true, version } : refused("cli_version_mismatch")
  } catch (error) {
    return refused((error as NodeJS.ErrnoException)?.code === "ENOENT" ? "cli_missing" : "adapter_start_failed", error)
  } finally {
    if (home) rmSync(home, { recursive: true, force: true })
  }
}
