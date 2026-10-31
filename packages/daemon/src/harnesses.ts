// Detects which harness CLIs are installed on this device and their
// versions; reported on device registration and heartbeats.
import type { Harness, HarnessInfo } from "@mikka/protocol"
import { execa } from "execa"

import { buildChildEnv } from "./env"
import { daemonTestMode } from "@mikka/protocol/repository"
import { detectHarnessCatalogue } from "./harness-models"
import { DAEMON_VERSION } from "./paths"

/** Candidate binaries per harness, tried in order. */
export const HARNESS_BINARIES: Record<Exclude<Harness, "mock">, string[]> = {
  claude_code: ["claude"],
  codex: ["codex"],
  cursor: ["cursor-agent", "agent"],
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
