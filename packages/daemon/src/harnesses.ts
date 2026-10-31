// Detects which harness CLIs are installed on this device and their
// versions; reported on device registration and heartbeats.
import { readdirSync, statSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { delimiter, isAbsolute, join } from "node:path"

import type { Harness, HarnessInfo } from "@mikka/protocol"
import { execa } from "execa"

import { buildChildEnv } from "./env"
import { daemonTestMode } from "@mikka/protocol/repository"
import { detectHarnessCatalogue } from "./harness-models"
import { appendToPath, findOnPath } from "./path-search"
import { DAEMON_VERSION } from "./paths"

/** Candidate binaries per harness, tried in order. */
export const HARNESS_BINARIES: Record<Exclude<Harness, "mock">, string[]> = {
  claude_code: ["claude"],
  codex: ["codex"],
  cursor: ["cursor-agent", "agent"],
}

const LOGIN_SHELL_TIMEOUT_MS = 5_000
const PATH_MARKER = "__MIKKA_PATH__"

function subdirectories(directory: string) {
  try {
    return readdirSync(directory).map(name => join(directory, name))
  } catch {
    return []
  }
}

/**
 * Where the official installers and version managers put agent CLIs. A service
 * keeps the PATH it was installed with, so a CLI installed later, or with a
 * manager that only initializes in interactive shells, is not on it.
 */
export function knownAgentDirectories(home = homedir()): string[] {
  return [
    join(home, ".local/bin"),
    join(home, "bin"),
    join(home, ".claude/local"),
    join(home, ".npm-global/bin"),
    join(home, ".bun/bin"),
    join(home, ".volta/bin"),
    join(home, ".local/share/pnpm"),
    join(home, "Library/pnpm"),
    join(home, ".asdf/shims"),
    join(home, ".local/share/mise/shims"),
    ...subdirectories(join(home, ".nvm/versions/node")).map(version => join(version, "bin")),
    ...subdirectories(join(home, ".local/share/fnm/node-versions")).map(version => join(version, "installation/bin")),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/snap/bin",
  ]
}

/** The PATH a person gets in their own terminal; empty when the shell cannot say. */
export async function loginShellPath(shell = process.env.SHELL || userInfo().shell): Promise<string[]> {
  if (!shell || !isAbsolute(shell)) return []
  let timer: NodeJS.Timeout | undefined
  try {
    // Its own process group: a startup file may leave processes holding the
    // output open, and waiting for those must never delay the daemon.
    const shellProcess = execa(shell, ["-ilc", `printf '${PATH_MARKER}%s${PATH_MARKER}' "$PATH"`], {
      stdin: "ignore",
      detached: true,
      reject: false,
    })
    const timedOut = new Promise<null>(resolve => {
      timer = setTimeout(() => {
        try {
          process.kill(-shellProcess.pid!, "SIGKILL")
        } catch {
          // Already gone.
        }
        resolve(null)
      }, LOGIN_SHELL_TIMEOUT_MS)
    })
    const result = await Promise.race([shellProcess, timedOut])
    // Startup files may print anything around the marked value.
    return String(result?.stdout ?? "").split(PATH_MARKER)[1]?.split(delimiter).filter(isAbsolute) ?? []
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

/** Which binary each harness resolves to and when it changed, without running anything. */
export function harnessFingerprint(): string {
  appendToPath(knownAgentDirectories())
  return Object.values(HARNESS_BINARIES).map(binaries => {
    for (const binary of binaries) {
      const found = findOnPath(binary)
      if (found) return `${found}:${statSync(found).mtimeMs}`
    }
    return ""
  }).join("|")
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

export async function detectHarnesses(): Promise<HarnessInfo[]> {
  // Children inherit this PATH, so what is detected here is also what runs.
  if (!daemonTestMode(process.env)) appendToPath([...await loginShellPath(), ...knownAgentDirectories()])
  const detected = await Promise.all(
    (Object.keys(HARNESS_BINARIES) as Exclude<Harness, "mock">[]).map(
      async (harness): Promise<HarnessInfo> => {
        for (const binary of HARNESS_BINARIES[harness]) {
          const version = await versionOf(binary)
          if (version) {
            const catalogue = await detectHarnessCatalogue(harness,binary)
            return { harness, installed: true, version, ...catalogue }
          }
        }
        return { harness, installed: false, version: null }
      }
    )
  )
  return [
    ...detected,
    ...(daemonTestMode(process.env) ? [{ harness: "mock" as const, installed: true, version: DAEMON_VERSION }] : []),
  ]
}
