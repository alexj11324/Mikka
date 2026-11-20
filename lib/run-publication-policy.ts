import { issueBranch } from '@mikka/protocol/orchestrator'
import type { RunReport } from '@mikka/protocol/run'
import type { PublicationErrorCode } from '@/lib/github/run-pull-request'
import { pullRequestBranchPrefix } from '@/lib/code-review/settings-contract'

/** A per-repository push approval stored before decision 2026-11-02-1600. Kept for old rows; nothing reads it. */
export interface RepositoryPushApproval {
  approved: boolean
  remote?: string
  approvedByUserId?: string
  approvedAt?: string
}

/** The task's own identifier as its branch (`mikka/al-12`); every task has one from creation. */
export function publicationBranch(identifier: string | null | undefined, prefix = 'mikka'): string | null {
  const match = identifier?.match(/^([a-z0-9]+(?:-[a-z0-9]+)*)-([1-9][0-9]*)$/i)
  const parsed = pullRequestBranchPrefix.safeParse(prefix)
  if (!match || !Number.isSafeInteger(Number(match[2])) || !parsed.success) return null
  const name = issueBranch(match[1], Number(match[2])).slice('mikka/'.length)
  return parsed.data ? `${parsed.data}/${name}` : name
}

/** Failed verification can never become ready through a saved preference. */
export function publicationDraft(preferred: boolean, verify: RunReport['verify']['status'], factoryBound = false) {
  return preferred || verify === 'failed' || (verify === 'not_run' && !factoryBound)
}

/** Provider validation retains the task identifier, even with a custom path. */
export function validPublicationBranch(branch: string, identifier: string) {
  const slash = branch.lastIndexOf('/')
  return publicationBranch(identifier, slash < 0 ? '' : branch.slice(0, slash)) === branch
}

export function publicationGate(input: {
  stopReason: string | null; kind: string; report: RunReport | null
  assignment: { branch: string | null } | null
}): { state: 'skipped' } | { state: 'blocked'; error: PublicationErrorCode } | { state: 'pending' } {
  const { report, assignment } = input
  if (input.stopReason !== 'submitted' || input.kind === 'plan' || !report || report.verify.status === 'failed') return { state: 'skipped' }
  if (report.publish?.skipped === 'no_changes' && !report.publish.pushed) return { state: 'skipped' }
  if (!assignment) return { state: 'blocked', error: 'publication_missing' }
  if (!assignment.branch) return { state: 'blocked', error: 'task_identifier_required' }
  if (!report.publish?.pushed) return { state: 'blocked', error: 'push_failed' }
  if (report.publish.branch !== assignment.branch || report.publish.remote !== 'origin' || !report.publish.commit || !/^[a-f0-9]{40,64}$/i.test(report.publish.commit)) return { state: 'blocked', error: 'publication_mismatch' }
  return { state: 'pending' }
}
