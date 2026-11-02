// The repo's verify command, run by the daemon after a hand-in, with the
// agent's own (unsandboxed) launcher and a fresh temp dir. The write, read
// and network lists below describe the run's policy; nothing enforces them
// (decision 2026-11-01-2335): a read-only run's verify can write the worktree.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
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
  /** The run is a read-only check (ADR 0046); see the decision above. */
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
/**
 * bwrap masks a denied file by bind-mounting /dev/null on its path. The
 * daemon replaces some of those files by rename (`runs.json` on every chunk,
 * `device.json` on every sync), and a rename between bwrap's mount and its
 * mount-table check aborts the sandbox before the command runs ("Can't bind
 * mount /oldroot/dev/null on ..."). Such an attempt is started again; one
 * where the command began is never repeated.
 */
const SETUP_ATTEMPTS = 3

export async function runVerify(
  sandbox: AgentSandbox,
  options: VerifyOptions
): Promise<VerifyResult> {
  // Somewhere the agent could never write: nothing in it was planted.
  mkdirSync(options.tmpRoot, { recursive: true, mode: 0o700 })
  const tmpDir = mkdtempSync(join(realpathSync(options.tmpRoot), "verify-"))
  const deadline = Date.now() + options.timeoutMs
  try {
    for (let attempt = 1; ; attempt++) {
      const started = join(tmpDir, `.started-${attempt}`)
      const result = await attemptVerify(sandbox, options, tmpDir, started, deadline - Date.now())
      if (
        result.exitCode === 0 ||
        result.timedOut ||
        options.signal?.aborted ||
        existsSync(started) ||
        attempt >= SETUP_ATTEMPTS
      )
        return result
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

async function attemptVerify(
  sandbox: AgentSandbox,
  options: VerifyOptions,
  tmpDir: string,
  started: string,
  timeoutMs: number
): Promise<VerifyResult> {
  // The marker is written inside the sandbox, so it exists only once the
  // sandbox is set up and the command is about to run.
  const child = await spawnCli(
    sandbox,
    ["/bin/sh", "-c", ': > "$0" && exec /bin/sh -c "$1"', started, options.command],
    {
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
    }
  )
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
  }, Math.max(0, timeoutMs))
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
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", abort)
  }
}
