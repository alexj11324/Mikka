// The one isolation layer for agent CLIs (ADR 0009, "Stage 1 isolation"):
// Anthropic's sandbox-runtime, behind Mikka's own interface so it can be
// swapped. Reads stay open (sandbox-runtime's default) except the paths a
// run denies (credential stores), writes are limited to the paths a run
// declares (its worktree, its run dir, the harness's own state), and the network goes through sandbox-runtime's
// proxy with a per-run domain allow-list. Anything else the agent tries is
// denied; a host no list covers goes to `onAsk` (deny by default) so it can
// surface as an approval later.
//
// sandbox-runtime keeps one proxy per process, so the daemon initializes it
// once and gives each run its own filesystem rules (per-wrap config) and
// domain list (per-command network list keyed by an unguessable id).
//
// Verified on macOS 27 (Seatbelt): a sandbox cannot apply a second Seatbelt
// profile (`sandbox_apply: Operation not permitted`), so every harness runs
// with its own sandbox off; this layer replaces it.
import { randomBytes } from "node:crypto"

import { SandboxManager } from "@anthropic-ai/sandbox-runtime"
import { execa } from "execa"

export interface SandboxPolicy {
  /** Absolute paths the command may write (and create files under). */
  allowWrite: string[]
  /** Paths inside `allowWrite` that stay read-only. */
  denyWrite?: string[]
  /** Paths the command may not read (reads are open otherwise). */
  denyRead?: string[]
  /** Domains the command may reach (`host`, `*.host`, `host:port`). */
  allowDomains: string[]
}

export interface SandboxedCommand {
  /** Run with `/bin/sh -c <command>` and the caller's clean env. */
  command: string
  /** Sandbox violations seen for this command, appended to `stderr`. */
  annotate(stderr: string): string
  /** Drops the command's network list; call once the process exited. */
  release(): void
}

export interface AgentSandbox {
  readonly kind: "sandbox-runtime" | "none"
  wrap(argv: string[], policy: SandboxPolicy): Promise<SandboxedCommand>
}

/** A host no run's list covers; return false to deny (the default). */
export type AskNetwork = (request: {
  host: string
  port: number | undefined
}) => Promise<boolean>

/** POSIX single-quote quoting: safe for any byte string in `/bin/sh`. */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg
  return `'${arg.replaceAll("'", `'"'"'`)}'`
}

export function shellJoin(argv: string[]): string {
  return argv.map(shellQuote).join(" ")
}

export class SandboxRuntime implements AgentSandbox {
  readonly kind = "sandbox-runtime" as const
  private ready: Promise<void> | null = null

  constructor(private readonly onAsk?: AskNetwork) {}

  /** The platform is supported and its tools (Linux: bwrap, socat, rg) exist. */
  static supported(): boolean {
    return (
      SandboxManager.isSupportedPlatform() &&
      SandboxManager.checkDependencies().errors.length === 0
    )
  }

  /** Check that the runtime can actually start isolation on this host. */
  async probe(): Promise<void> {
    const wrapped = await this.wrap(["/bin/sh", "-c", ":"], {
      allowWrite: [],
      allowDomains: [],
    })
    try {
      const result = await execa("/bin/sh", ["-c", wrapped.command], {
        reject: false,
        timeout: 10_000,
      })
      if (result.failed) {
        throw new Error(
          `sandbox probe failed: ${result.timedOut ? "timed out" : result.stderr.trim() || `exit ${result.exitCode}`}`
        )
      }
    } finally {
      wrapped.release()
    }
  }

  private init() {
    this.ready ??= SandboxManager.initialize(
      {
        // Everything is per run (`registerCommandNetworkLists`).
        network: { allowedDomains: [], deniedDomains: [] },
        filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
        // Rust and Go CLIs (codex) verify TLS through trustd; without it
        // every HTTPS request from them fails inside the sandbox.
        enableWeakerNetworkIsolation: true,
      },
      async ({ host, port }) => (await this.onAsk?.({ host, port })) === true
    ).catch((error: unknown) => {
      this.ready = null
      throw error
    })
    return this.ready
  }

  async wrap(argv: string[], policy: SandboxPolicy): Promise<SandboxedCommand> {
    await this.init()
    // The proxy username carries this id; it must be unguessable.
    const commandId = randomBytes(16).toString("base64url")
    const command = await SandboxManager.wrapWithSandbox(
      shellJoin(argv),
      "/bin/sh",
      {
        filesystem: {
          denyRead: policy.denyRead ?? [],
          allowWrite: policy.allowWrite,
          denyWrite: policy.denyWrite ?? [],
        },
      },
      undefined,
      { commandId }
    )
    SandboxManager.registerCommandNetworkLists(commandId, {
      allowedDomains: policy.allowDomains,
    })
    let released = false
    return {
      command,
      annotate: (stderr) =>
        SandboxManager.annotateStderrWithSandboxFailures(commandId, stderr),
      release() {
        if (released) return
        released = true
        SandboxManager.unregisterCommandNetworkLists(commandId)
      },
    }
  }

  /** Stops the proxy; the next `wrap` starts it again. */
  async reset() {
    if (!this.ready) return
    this.ready = null
    await SandboxManager.reset()
  }
}

/**
 * No isolation at all. Only for tests of the adapters' protocol handling
 * with fake CLIs, and for platforms sandbox-runtime does not support when
 * the user explicitly opts out; never the default.
 */
export class NoSandbox implements AgentSandbox {
  readonly kind = "none" as const

  async wrap(argv: string[]): Promise<SandboxedCommand> {
    return {
      command: `exec ${shellJoin(argv)}`,
      annotate: (stderr) => stderr,
      release() {},
    }
  }
}
