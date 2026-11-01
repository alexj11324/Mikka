// The device's capability report: what this machine can run, not which
// agents the person installed. The daemon runs its own pinned Claude Code
// and Codex (harness-install.ts), so a device needs neither installed; it
// reports OS/arch, free disk, Docker and each harness's install state.
import { statfsSync } from "node:fs"
import { arch, platform } from "node:os"

import type { DeviceRunnerCapability, HarnessInfo } from "@mikka/protocol"
import { execa } from "execa"

import { daemonTestMode } from "@mikka/protocol/repository"
import { managedHarnessReport, type HarnessStore } from "./harness-install"
import { DAEMON_VERSION } from "./paths"

/** Whether a Docker engine answers; the CLI alone is not enough. */
export async function dockerAvailable(): Promise<boolean> {
  try {
    const { exitCode } = await execa("docker", ["info", "--format", "{{.ServerVersion}}"], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      extendEnv: false,
      timeout: 5_000,
      stdin: "ignore",
      reject: false,
    })
    return exitCode === 0
  } catch {
    return false
  }
}

export function freeDiskBytes(dir: string): number | null {
  try {
    const stats = statfsSync(dir)
    return Number(stats.bavail) * Number(stats.bsize)
  } catch {
    return null
  }
}

export async function deviceCapabilities(
  store: HarnessStore,
  dataDir: string,
  docker: () => Promise<boolean> = dockerAvailable,
): Promise<DeviceRunnerCapability> {
  return {
    os: platform(),
    arch: arch(),
    freeDiskBytes: freeDiskBytes(dataDir),
    docker: await docker(),
    harnesses: managedHarnessReport(store),
  }
}

/**
 * Harnesses this device can run: every managed one with a build for this
 * platform, installed yet or not (the first run installs it).
 */
export function detectHarnesses(store: HarnessStore): HarnessInfo[] {
  return [
    ...managedHarnessReport(store).map(({ harness, state, version }) => ({
      harness,
      installed: state !== "unsupported",
      version,
    })),
    ...(daemonTestMode(process.env) ? [{ harness: "mock" as const, installed: true, version: DAEMON_VERSION }] : []),
  ]
}

/** Changes when an install finishes, so the next heartbeat reports it. */
export function harnessFingerprint(store: HarnessStore): string {
  return managedHarnessReport(store).map(({ harness, state, version }) => `${harness}:${version}:${state}`).join("|")
}
