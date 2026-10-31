/**
 * Paths that can hold a credential: what a cloud snapshot must never capture
 * (decision 2026-10-31-2225: snapshots hold software only, never credentials)
 * and what run cleanup removes. One list for the snapshot guard
 * (lib/cloud-computer/thread-machines.ts) and the daemon, so the two cannot
 * drift. Dependency-free: the web app imports it.
 */
/** The cloud worker's adapter state dir (`<dataDir>/adapters`; bin/cloud-worker.ts). */
export const CLOUD_WORKER_STATE_DIR = "/home/mikka-runner/.mikka/worker/adapters"

/**
 * Paths inside a run dir that can hold a credential. Each is written again when
 * a session starts, so removing them never blocks a resume.
 */
export const RUN_CREDENTIAL_PATHS: readonly string[] = [
  // GitHub token config and gh wrapper (agents/github-runtime.ts).
  "github",
  // Coding-CLI homes inside a run: only placeholders today, but a real login must never be kept.
  "runtime-home/.claude/.credentials.json",
  "runtime-home/.codex/auth.json",
]

/** Run-scoped paths under a state dir that can hold a credential. */
export function runCredentialGlobs(stateDir: string): string[] {
  return [
    ...RUN_CREDENTIAL_PATHS.map((path) => `${stateDir}/runs/*/${path}`),
    // Live native subscription brokers (subscription-native-broker.ts).
    `${stateDir}/native-brokers/*`,
  ]
}

/** Shell globs, absolute on a cloud machine, whose presence makes a snapshot unsafe. */
export const SNAPSHOT_CREDENTIAL_GLOBS: readonly string[] = [
  "/root/.claude/.credentials.json",
  "/root/.codex/auth.json",
  "/home/*/.claude/.credentials.json",
  "/home/*/.codex/auth.json",
  "/home/*/.config/gh/hosts.yml",
  "/home/*/.git-credentials",
  "/root/.git-credentials",
  ...runCredentialGlobs(CLOUD_WORKER_STATE_DIR),
]

/** A POSIX shell command that prints each credential path present, one per line, and nothing else. */
export function credentialProbeCommand(globs: readonly string[] = SNAPSHOT_CREDENTIAL_GLOBS): string {
  for (const glob of globs) if (!/^\/[A-Za-z0-9._*\/-]+$/.test(glob)) throw new Error("Unsafe credential glob")
  return `for p in ${globs.join(" ")}; do if [ -e "$p" ]; then printf '%s\\n' "$p"; fi; done; true`
}

/** A POSIX shell command that removes every credential path present. */
export function credentialScrubCommand(globs: readonly string[] = SNAPSHOT_CREDENTIAL_GLOBS): string {
  credentialProbeCommand(globs)
  return `rm -rf -- ${globs.join(" ")}`
}

