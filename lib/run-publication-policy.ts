import { issueBranch } from '@mikka/protocol/orchestrator'
import type { RunReport } from '@mikka/protocol/run'
import type { PublicationErrorCode } from '@/lib/github/run-pull-request'

/** A per-repository push approval stored before decision 2026-11-02-1600. Kept for old rows; nothing reads it. */
export interface RepositoryPushApproval {
  approved: boolean
  remote?: string
  approvedByUserId?: string
  approvedAt?: string
}

/** A task's own identifier as its branch; `deliveryIdentifier` supplies one when the task has none. */
export function publicationBranch(identifier: string | null | undefined): string | null {
  const match = identifier?.match(/^([a-z0-9]+(?:-[a-z0-9]+)*)-([1-9][0-9]*)$/i)
  if (!match || !Number.isSafeInteger(Number(match[2]))) return null
  return issueBranch(match[1], Number(match[2]))
}

/**
 * The identifier a task delivers under. A task without a branch-ready
 * identifier (a workspace task with no Linear link, or a personal one with no
 * prefix) gets a stable one from its id, so every finished run can push its
 * branch and open its pull request.
 */
export function deliveryIdentifier(identifier: string | null | undefined, issueId: string): string {
  if (identifier && publicationBranch(identifier)) return identifier
  const hex = issueId.replace(/-/g, '').slice(0, 8)
  if (!/^[0-9a-f]{8}$/i.test(hex)) throw new Error('Task id is not a UUID')
  return `TASK-${Number.parseInt(hex, 16) + 1}`
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
