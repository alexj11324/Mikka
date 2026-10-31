// Isolated harness config dirs (ADR 0009; devices are runners, 2026-10-31):
// each run's CLI gets a home of its own in the run's dir, so the person's
// `~/.claude`, `~/.codex` and `~/.cursor` (hooks, MCP servers, rules,
// history, logins) are never read or written, and one run cannot plant
// instructions for another. The agent can write its home, so the daemon
// never follows a link it finds there. A run's credential comes only from
// the model resolver (the bot owner's subscription or a member's share),
// in memory or on a pipe; any credential file a CLI writes into its run
// home is wiped when the run ends, and on the next daemon start after a
// crash or kill.
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

import type { Logger } from "../log"

export interface CodexHome {
  /** Value for `CODEX_HOME`. */
  home: string
}

/** Settings every Mikka Codex run starts from; nothing from the user's config. */
export const CODEX_CONFIG = [
  "# Written by Mikka for agent runs. Edits are overwritten.",
  'approval_policy = "on-request"',
  // Mikka's sandbox is the boundary; Codex's own Seatbelt cannot nest in it.
  'sandbox_mode = "danger-full-access"',
  "",
].join("\n")

/** Credential files a CLI may write inside its run home. */
const RUN_CREDENTIAL_FILES = [
  ["codex-home", "auth.json"],
  ["native-home", ".claude", ".credentials.json"],
  ["native-home", ".codex", "auth.json"],
  ["runtime-home", ".claude", ".credentials.json"],
  ["runtime-home", ".codex", "auth.json"],
]

export function prepareCodexHome(dir: string, log: Logger): CodexHome {
  ownDir(dir)
  writeOwnFile(join(dir, "config.toml"), CODEX_CONFIG)
  if (lstatSync(join(dir, "auth.json"), { throwIfNoEntry: false })) {
    log.warn("removing a credential file left in the run's codex home")
    rmSync(join(dir, "auth.json"), { force: true, recursive: true })
  }
  return { home: dir }
}

/** Removes every credential file from one run dir; keeps its history. */
export function wipeRunCredentials(runDir: string) {
  for (const parts of RUN_CREDENTIAL_FILES) {
    rmSync(join(runDir, ...parts), { force: true, recursive: true })
  }
}

/**
 * Wipes credentials from every run dir under the adapter state dir: the
 * cleanup a crashed or killed daemon could not do. Run at daemon start.
 */
export function sweepRunCredentials(stateDir: string) {
  let runs: string[]
  try {
    runs = readdirSync(join(stateDir, "runs"))
  } catch {
    return
  }
  for (const run of runs) wipeRunCredentials(join(stateDir, "runs", run))
}

/** Replaces whatever is at `file` (a planted link included) with new content. */
function writeOwnFile(file: string, content: string) {
  rmSync(file, { force: true, recursive: true })
  writeFileSync(file, content, { flag: "wx", mode: 0o600 })
}

/** A real directory at `dir`; a planted link or file there is removed. */
export function ownDir(dir: string) {
  const stat = lstatSync(dir, { throwIfNoEntry: false })
  if (stat && !stat.isDirectory()) rmSync(dir, { force: true })
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

/**
 * A follow-up run continues the earlier run's conversation, which its CLI
 * stored in that run's home: copy the named history entries (`sessions`,
 * say) over before the CLI starts. Only those entries, never config or
 * instructions, and no links (the agent could write that home).
 */
export function carryHistory(from: string, to: string, entries: string[]) {
  if (!lstatSync(from, { throwIfNoEntry: false })?.isDirectory()) return
  ownDir(to)
  for (const entry of entries) {
    const source = join(from, entry)
    if (!lstatSync(source, { throwIfNoEntry: false })) continue
    cpSync(source, join(to, entry), {
      recursive: true,
      force: true,
      filter: (path) => !lstatSync(path).isSymbolicLink(),
    })
  }
}

export function prepareCursorHome(dir: string): string {
  ownDir(dir)
  return dir
}
