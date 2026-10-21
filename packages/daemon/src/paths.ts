import { homedir } from "node:os"
import { join } from "node:path"

import type { Flavor } from "@orvilo/protocol"

import pkg from "../package.json" with { type: "json" }

export const DAEMON_VERSION: string = pkg.version

/** Same folder names Electron uses for `userData` (docs/architecture.md, "Flavors"). */
export function productName(flavor: Flavor): string {
  return flavor === "dev" ? "Orvilo Dev" : "Orvilo"
}

/**
 * The flavor's data dir, matching Electron's `app.getPath("userData")` so the
 * desktop app and a headless daemon of the same flavor find the same socket.
 * `ORVILO_USER_DATA_DIR` overrides it for dev builds only (tests, parallel
 * worktrees), mirroring apps/desktop/src/main/index.ts.
 */
export function defaultDataDir(
  flavor: Flavor,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  if (flavor === "dev" && env.ORVILO_USER_DATA_DIR) {
    return env.ORVILO_USER_DATA_DIR
  }
  const home = env.HOME || homedir()
  const name = productName(flavor)
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", name)
  }
  if (platform === "win32") {
    return join(env.APPDATA || join(home, "AppData", "Roaming"), name)
  }
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), name)
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
    adapterState: join(dataDir, "adapters"),
    logs: join(dataDir, "logs"),
    devRepos: join(dataDir, "dev-repos.json"),
  }
}
export type DaemonPaths = ReturnType<typeof daemonPaths>
