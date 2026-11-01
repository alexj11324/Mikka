import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type { Flavor } from "@mikka/protocol"

import pkg from "../package.json" with { type: "json" }

export const DAEMON_VERSION: string = pkg.version

/** Same folder names Electron uses for `userData` (docs/architecture.md, "Flavors"). */
export function productName(flavor: Flavor): string {
  return flavor === "dev" ? "Mikka Dev" : "Mikka"
}

/**
 * The flavor's data dir, matching Electron's `app.getPath("userData")` so the
 * desktop app and a headless daemon of the same flavor find the same socket.
 * `MIKKA_USER_DATA_DIR` overrides it for dev builds only (tests, parallel
 * worktrees), mirroring apps/desktop/src/main/index.ts.
 */
export function defaultDataDir(
  flavor: Flavor,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  if (flavor === "dev" && env.MIKKA_USER_DATA_DIR) {
    return env.MIKKA_USER_DATA_DIR
  }
  const home = env.HOME || homedir()
  const base =
    platform === "darwin"
      ? join(home, "Library", "Application Support")
      : platform === "win32"
        ? env.APPDATA || join(home, "AppData", "Roaming")
        : env.XDG_CONFIG_HOME || join(home, ".config")
  const dir = join(base, productName(flavor))
  // Machines linked before the Orvilo -> Mikka rename keep their device
  // token and run journal in the old folder; keep using it until it is moved.
  const legacy = join(base, legacyProductName(flavor))
  return !existsSync(dir) && existsSync(legacy) ? legacy : dir
}

function legacyProductName(flavor: Flavor): string {
  return flavor === "dev" ? "Orvilo Dev" : "Orvilo"
}

/** Every file the daemon owns inside its data dir. */
export function daemonPaths(dataDir: string) {
  return {
    dataDir,
    socket: join(dataDir, "daemon.sock"),
    lock: join(dataDir, "daemon.lock"),
    secret: join(dataDir, "daemon.secret"),
    device: join(dataDir, "device.json"),
    journal: join(dataDir, "runs.json"),
    outbox: join(dataDir, "outbox"),
    worktrees: join(dataDir, "worktrees"),
    repos: join(dataDir, "repos"),
    adapterState: join(dataDir, "adapters"),
    /** Pinned Claude Code and Codex the daemon installs for its runs. */
    harness: join(dataDir, "harness"),
    logs: join(dataDir, "logs"),
    devRepos: join(dataDir, "dev-repos.json"),
  }
}
export type DaemonPaths = ReturnType<typeof daemonPaths>
