import type { RunAssignment } from './server-link'
import { EmptyRepositoryError, type RepositoryCache } from './repositories'
import { withRunGitCredentials } from './agents/github-runtime'
import { pushDecision, runPolicy } from './permissions'
import { runDiagnosticsEnabled } from './run-runtime-timing'
import { runIdHash } from './tracing'

/** Prepare the claimed remote; empty-repository publication remains separate
 * from the read-only clone/fetch and uses the verified execution policy. */
export async function prepareRunRepository(repositories: RepositoryCache, privateDir: string,
  assignment: RunAssignment, signal: AbortSignal, githubEnvironment?: Record<string, string>,
  policyReady?: Promise<unknown>, hostDiagnostics?: boolean): Promise<void> {
  const remoteUrl = assignment.remoteUrl
  if (!remoteUrl) return
  const diagnostics = runDiagnosticsEnabled(assignment.taskEnv, hostDiagnostics)
    ? { runIdHash: runIdHash(assignment.runId), harness: assignment.harness } : undefined
  await withRunGitCredentials(assignment, privateDir, async (env, github) => {
    try { await repositories.prepare(remoteUrl, signal, env, diagnostics) }
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
      await repositories.prepare(remoteUrl, signal, env, diagnostics)
    }
  }, githubEnvironment)
}
