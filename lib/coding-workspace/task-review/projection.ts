import type { DiffFileMetadata, DiffFilePatch, DiffSnapshot, TaskReviewRef } from '@mikka/protocol/coding-workspace-review'
import { UNFINISHED_RUN_STATUSES } from '../../agent-run-statuses'
import type { ReviewActor, ReviewScope } from '../diff/authority'
import { matchingPullState } from '../diff/github-state'
import type { latestTaskReviewChecks } from './checks'

export const reviewReference = (snapshot: DiffSnapshot): TaskReviewRef => ({ snapshotId: snapshot.id, sourceVersion: snapshot.revision.version })

export type TaskSummaryFacts = { branch: string | null; reclaimed: boolean; canMerge: boolean; merging: boolean; mergeBinding: unknown; pullObservation?: unknown }
export type TaskSummaryChecks = Awaited<ReturnType<typeof latestTaskReviewChecks>>

/** Metadata projection shared by detail and bulk reads. Importing it must not
 * initialize authentication, provider clients, or the request handlers. */
export function projectTaskReviewSummary(actor: Pick<ReviewActor, 'userId' | 'workspaceId' | 'credential'>, scope: ReviewScope,
  snapshot: DiffSnapshot | null, facts: TaskSummaryFacts | undefined, checks: TaskSummaryChecks) {
  const own = actor.userId === scope.identity.ownerId && actor.credential.kind === 'session'
  const available = snapshot && snapshot.availability !== 'unavailable'
  const pull = snapshot ? matchingPullState(facts?.pullObservation, snapshot) : null
  const state = pull?.state ?? snapshot?.pullRequest?.state
  const canSend = Boolean(own && available && !facts?.merging), canMerge = Boolean(own && state && !['closed', 'merged'].includes(state) && facts?.canMerge)
  const countsKnown = Boolean(available && snapshot.counts.complete)
  return { taskId: scope.taskId!, reviewRef: available ? reviewReference(snapshot) : null, pr: snapshot?.pullRequest ? {
    number: snapshot.pullRequest.number, url: snapshot.pullRequest.url, state: state!, observedAt: pull?.observedAt ?? snapshot.observedAt,
  } : null, files: available ? snapshot.counts.files : null, additions: countsKnown ? snapshot!.counts.additions : null,
  deletions: countsKnown ? snapshot!.counts.deletions : null, countsKnown, checks,
  mergeTarget: canMerge ? { reviewRef: reviewReference(snapshot!), binding: facts!.mergeBinding, expectedHeadSha: snapshot!.revision.headSha } : null,
  running: !scope.stopped && UNFINISHED_RUN_STATUSES.some(status => status === scope.status), ...(facts?.branch ? { branch: facts.branch } : {}),
  permissions: { canMerge, canSend, canTerminal: own, reasons: {
    ...(!canMerge ? { merge: own ? 'review_unavailable' : 'not_owner_merge' } : {}),
    ...(!canSend ? { send: own ? 'review_unavailable' : 'not_owner_send' } : {}),
    ...(!own ? { terminal: 'not_owner_terminal' } : {}),
  } }, live: { workspaceId: actor.workspaceId }, reclaimed: facts?.reclaimed ?? false }
}
export type TaskReviewSummary = ReturnType<typeof projectTaskReviewSummary>

/** Missing lazy patches have unknown counts. In particular, the zeroes in a
 * working-tree manifest are not evidence of an empty change. */
export function taskReviewFile(file: DiffFileMetadata, input: { patch?: DiffFilePatch | null; reviewed?: boolean; comments: number; countsKnown?: boolean }) {
  const patch = input.patch, known = input.countsKnown ?? Boolean(patch && ['text', 'binary'].includes(patch.format))
  return { path: file.path, ...(file.previousPath ? { previousPath: file.previousPath } : {}), status: file.status,
    fileVersion: file.fileVersion, additions: known ? (patch?.file.additions ?? file.additions) : null,
    deletions: known ? (patch?.file.deletions ?? file.deletions) : null, countsKnown: known,
    viewed: input.reviewed ?? false, patch: patch?.patch ?? null, format: patch?.format ?? 'unloaded',
    tooLarge: patch?.format === 'too_large', comments: input.comments }
}

export function taskReviewDiff(snapshot: DiffSnapshot, files: ReturnType<typeof taskReviewFile>[], input: {
  running: boolean; reclaimed: boolean; nextCursor: string | null;
}) {
  return { reviewRef: snapshot.availability === 'unavailable' ? null : reviewReference(snapshot), source: {
    kind: snapshot.revision.source === 'working' ? 'machine' : snapshot.revision.source === 'pull_request' ? 'pr' : snapshot.revision.source,
    at: snapshot.observedAt, reclaimed: input.reclaimed, stale: snapshot.isStale,
  }, live: snapshot.revision.source === 'working' && snapshot.availability !== 'unavailable' && input.running && !input.reclaimed && !snapshot.isStale,
  base: snapshot.revision.baseSha, head: snapshot.revision.headSha, files,
  availability: snapshot.availability, reason: snapshot.reason, empty: snapshot.availability === 'empty',
  ...(input.nextCursor ? { nextCursor: input.nextCursor } : {}) }
}
