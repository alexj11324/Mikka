// The repo's verify command, run by the daemon after a hand-in. It runs
// code the agent wrote (tests, build scripts), so it gets the agent's
// boundary: writes only to the worktree and its own temp dir (never the
// `.git` file or the git dir), no credential stores, and only the repo's
// own `networkAllow` domains (no model APIs).
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { join } from "node:path"

import { spawnCli } from "./child"
import { credentialDenyRead, daemonSecrets } from "./run-context"
import type { AgentSandbox } from "./sandbox"

export interface VerifyOptions {
  command: string
  /** Real path of the worktree. */
  worktree: string
  /** Daemon-only dir; verify gets a fresh temp dir inside it. */
  tmpRoot: string
  /** The daemon's data dir; its secrets are unreadable. */
  privateDir: string
  /** Daemon-only file for verify's process group id. */
  pidFile: string
  networkAllow?: readonly string[]
  /** Clean env from `buildChildEnv`. */
  env: Record<string, string>
  timeoutMs: number
  signal?: AbortSignal
  /**
   * The run is a read-only check (ADR 0046): verify may not write the
   * worktree either. A command that needs to (a formatter, a snapshot test)
   * then fails instead of leaving the tree dirty for the next run — it would
   * have failed the daemon's own tree comparison anyway.
   */
  readOnly?: boolean
}

export interface VerifyResult {
  /** Null when killed (timeout, abort) or not started. */
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  /** Last part of stdout and stderr, interleaved, plus sandbox denials. */
  output: string
}

const OUTPUT_TAIL = 4000

export async function runVerify(
  sandbox: AgentSandbox,
  options: VerifyOptions
): Promise<VerifyResult> {
  // Somewhere the agent could never write: nothing in it was planted.
  mkdirSync(options.tmpRoot, { recursive: true, mode: 0o700 })
  const tmpDir = mkdtempSync(join(realpathSync(options.tmpRoot), "verify-"))
  const child = await spawnCli(sandbox, ["/bin/sh", "-c", options.command], {
    cwd: options.worktree,
    env: { ...options.env, TMPDIR: tmpDir },
    policy: {
      allowWrite: options.readOnly ? [tmpDir] : [options.worktree, tmpDir],
      denyWrite: [
        join(options.worktree, ".git"),
        ...(options.readOnly ? [options.worktree] : []),
      ],
      denyRead: [
        ...credentialDenyRead(null),
        ...daemonSecrets(options.privateDir),
      ],
      allowDomains: [...(options.networkAllow ?? [])],
    },
    pidFile: options.pidFile,
    // Every verify of this run carries the temp root in its profile.
    marker: realpathSync(options.tmpRoot),
  })
  child.process.stdin.end()
  let output = ""
  for (const stream of [child.process.stdout, child.process.stderr]) {
    stream.setEncoding("utf8")
    stream.on("data", (data: string) => {
      output = (output + data).slice(-OUTPUT_TAIL * 4)
    })
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    void child.kill()
  }, options.timeoutMs)
  const abort = () => void child.kill()
  options.signal?.addEventListener("abort", abort, { once: true })
  try {
    const { code, signal } = await child.exited
    // Sandbox denials explain most surprising failures; stderrTail has them.
    const denials = child.stderrTail().split("<sandbox_violations>")[1]
    return {
      exitCode: code,
      signal,
      timedOut,
      output: [
        output.slice(-OUTPUT_TAIL),
        ...(code !== 0 && denials ? [`<sandbox_violations>${denials}`] : []),
      ].join("\n"),
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", abort)
  }
}
