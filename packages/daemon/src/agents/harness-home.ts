// Isolated harness config dirs (ADR 0009): each run's CLI gets a home of
// its own in the run's dir, so the user's hooks, MCP servers, rules and
// history in `~/.codex` / `~/.cursor` never load, and one run cannot plant
// instructions for another. The agent can write its home, so the daemon
// never follows a link it finds there. Credentials are never copied in:
//
// - Codex reads `auth.json` from `CODEX_HOME`; the isolated home holds a
//   symlink to the user's own file, which the sandbox lets the CLI rewrite
//   in place when it refreshes the token. Should the CLI ever replace the
//   link with a file of its own, the next run removes that copy and links
//   again.
// - Cursor keeps its login in the macOS Keychain, independent of
//   `CURSOR_CONFIG_DIR`, so its isolated dir starts empty.
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type { Logger } from "../log"

export interface CodexHome {
  /** Value for `CODEX_HOME`. */
  home: string
  /** Real path of the user's `auth.json` (writable for token refresh), if any. */
  authFile: string | null
}

/** Settings every Orvilo Codex run starts from; nothing from the user's config. */
export const CODEX_CONFIG = [
  "# Written by Orvilo for agent runs. Edits are overwritten.",
  'approval_policy = "never"',
  // Orvilo's sandbox is the boundary; Codex's own Seatbelt cannot nest in it.
  'sandbox_mode = "danger-full-access"',
  "",
].join("\n")

export function prepareCodexHome(
  dir: string,
  log: Logger,
  userHome = process.env.CODEX_HOME || join(homedir(), ".codex")
): CodexHome {
  ownDir(dir)
  writeOwnFile(join(dir, "config.toml"), CODEX_CONFIG)
  const link = join(dir, "auth.json")
  const userAuth = join(userHome, "auth.json")
  const current = lstatSync(link, { throwIfNoEntry: false })
  if (current && !current.isSymbolicLink()) {
    log.warn("codex replaced its auth link with a file; removing the copy")
  }
  if (current) rmSync(link, { force: true, recursive: true })
  if (!existsSync(userAuth)) return { home: dir, authFile: null }
  symlinkSync(userAuth, link)
  return { home: dir, authFile: realpathSync(userAuth) }
}

function codexAccount(text: string | null): string | null {
  try {
    const auth = JSON.parse(text ?? "") as { tokens?: { account_id?: string } }
    return auth.tokens?.account_id ?? null
  } catch {
    return null
  }
}

/**
 * The sandbox lets Codex rewrite the user's `auth.json` (token refresh).
 * The returned check, run once the CLI is gone, puts the file back as it
 * was if the run left it unreadable or signed in to another account. The
 * content only passes through the daemon's memory; it is never copied.
 * The account id is read from the file itself, so a file forged to keep
 * the same id passes, and a daemon crash skips the check: this catches
 * a swapped login, not a determined forgery (ADR 0017, Consequences).
 */
export function guardCodexAuth(
  authFile: string | null,
  log: Logger
): () => void {
  if (!authFile) return () => undefined
  const before = readFileSync(authFile, "utf8")
  const account = codexAccount(before)
  return () => {
    let after: string | null = null
    try {
      if (lstatSync(authFile).isFile()) after = readFileSync(authFile, "utf8")
    } catch {
      // Removed or replaced: restored below.
    }
    if (after !== null && codexAccount(after) === account) return
    log.warn("codex auth.json changed account during the run; restoring it")
    writeOwnFile(authFile, before)
  }
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
