import type { FactoryActivityView } from './factory/activity'
import { githubPullRequestKey } from './issue-metadata'
import type { IssueThread } from './issue-threads'

/** Map authorized publication receipts to conversations the reader can open. */
export function taskPullConversations(threads: readonly IssueThread[], factory?: FactoryActivityView | null) {
  const byRun = new Map<string, IssueThread>()
  for (const thread of threads) {
    if (!thread.detail) continue
    byRun.set(thread.id, thread)
    for (const attempt of thread.attempts) byRun.set(attempt.runId, thread)
  }
  const byPull = new Map<string, IssueThread>()
  for (const artifact of factory?.artifacts ?? []) {
    if (artifact.kind !== 'pull_request') continue
    const thread = byRun.get(artifact.runId)
    if (thread) byPull.set(githubPullRequestKey(artifact.url), thread)
  }
  return byPull
}
