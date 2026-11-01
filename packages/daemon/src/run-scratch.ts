import { rmSync } from "node:fs"
import { join } from "node:path"
import { runPaths } from "./agents/run-context"
import { RUN_CREDENTIAL_PATHS } from "./credential-globs"

/**
 * Run end, or any session close: drop the run's credentials (decision
 * 2026-10-31-2225). The run dir and native session ledger stay, because a
 * stopped run, a follow-up and a lost-lease retry resume from them.
 */
export function removeRunCredentials(stateDir: string, runId: string) {
  const { runDir } = runPaths(stateDir, runId)
  for (const path of RUN_CREDENTIAL_PATHS) rmSync(join(runDir, path), { recursive: true, force: true })
}

