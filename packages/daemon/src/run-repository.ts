import type { RunAssignment } from './server-link'
import { EmptyRepositoryError, type RepositoryCache } from './repositories'
import { withRunGitCredentials } from './agents/github-runtime'
import { pushDecision, runPolicy } from './permissions'
import { runDiagnosticsEnabled } from './run-runtime-timing'
import { runIdHash } from './tracing'
import { createRepositoryGitTimer, type RepositoryTimingObserver } from './repository-git-timing'

/** Prepare the claimed remote; empty-repository publication remains separate
 * from the read-only clone/fetch and uses the verified execution policy. */
export async function prepareRunRepository(repositories: RepositoryCache, privateDir: string,
  assignment: RunAssignment, signal: AbortSignal, githubEnvironment?: Record<string, string>,
  policyReady?: Promise<unknown>, hostDiagnostics?: boolean, onRepositoryTiming?: RepositoryTimingObserver): Promise<void> {
  const remoteUrl = assignment.remoteUrl
  if (!remoteUrl) return
  const diagnostics = runDiagnosticsEnabled(assignment.taskEnv, hostDiagnostics)
    ? { runIdHash: runIdHash(assignment.runId), harness: assignment.harness } : undefined
  const timer = diagnostics && onRepositoryTiming ? createRepositoryGitTimer(diagnostics.runIdHash, diagnostics.harness) : undefined
  const measured = diagnostics && timer ? { ...diagnostics, timer } : diagnostics
  let outcome: 'ok' | 'error' = 'error'
  try {
  await withRunGitCredentials(assignment, privateDir, async (env, github) => {
    try { await repositories.prepare(remoteUrl, signal, env, measured) }
    catch (error) {
      if (!(error instanceof EmptyRepositoryError)) throw error
      // Clone/fetch reads the repository already authorized by claim. A
      // first commit/push, even on an empty remote, still waits for the
      // existing fresh policy check and its final signed restrictions.
      await policyReady
      signal.throwIfAborted()
      if (!pushDecision(runPolicy(assignment.policy)).push) return repositories.localEmptyBase(remoteUrl)
      const branch = assignment.baseBranch && assignment.baseBranch !== 'HEAD' ? assignment.baseBranch : (await github.defaultBranch()) ?? 'main'
      await repositories.seedEmpty(remoteUrl, branch, signal, env)
      await repositories.prepare(remoteUrl, signal, env, measured)
    }
  }, githubEnvironment)
  outcome = 'ok'
  } finally {
    // Reporting cannot replace the original Git error or turn success into failure.
    try { if (timer) onRepositoryTiming?.(timer.finish(outcome)) } catch { /* diagnostic observer only */ }
  }
}
