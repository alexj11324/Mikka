// How the daemon starts an agent CLI. Runs use no sandbox (decision
// 2026-11-01-2335): the CLI runs directly, as the daemon's own user, on a
// person's computer or on the task's own E2B machine. `SandboxPolicy` still
// describes what a run's context declares (its worktree, run dir, domains).
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
  readonly kind: "none"
  wrap(argv: string[], policy: SandboxPolicy): Promise<SandboxedCommand>
}

/** POSIX single-quote quoting: safe for any byte string in `/bin/sh`. */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg
  return `'${arg.replaceAll("'", `'"'"'`)}'`
}

export function shellJoin(argv: string[]): string {
  return argv.map(shellQuote).join(" ")
}

/** Runs the command as it is (decision 2026-11-01-2335). */
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
