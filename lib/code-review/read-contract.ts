import { z } from 'zod'
import { diffSnapshot, reviewedFileChange, taskReviewRef, type TaskReviewRef } from '@mikka/protocol/coding-workspace-review'
import { REVIEW_DENIAL_REASONS, type ReviewCheck, type ReviewDiff, type ReviewFile, type ReviewFileRead, type ReviewRead, type ReviewSummary } from './contract'

export { taskReviewRef }

export const count = z.number().int().nonnegative()
export const reason = z.enum(REVIEW_DENIAL_REASONS)

export const summarySchema = z.object({
  taskId: z.string().min(1),
  pr: z.object({ number: z.number().int().positive(), state: z.enum(['open', 'changes_requested', 'approved', 'merged', 'closed']), url: z.string().url(), observedAt: z.iso.datetime().optional() }).nullable(),
  reviewRef: taskReviewRef.nullable().optional(),
  countsKnown: z.boolean().optional(),
  reclaimed: z.boolean().optional(),
  mergeTarget: z.object({
    reviewRef: taskReviewRef,
    binding: z.object({ taskId: z.string().min(1), issueId: z.string().min(1), attemptId: z.string().min(1), revision: count, candidateId: z.string().min(1) }),
    expectedHeadSha: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
  }).nullable().optional(),
  files: count.nullable(),
  additions: count.nullable(),
  deletions: count.nullable(),
  checks: z.object({ failed: count, passed: count, pending: count, total: count.optional(), neutral: count.optional(), sha: z.string().optional(), observedAt: z.iso.datetime().optional(), fingerprint: z.string().optional() }).nullable(),
  running: z.boolean(),
  branch: z.string().min(1).optional(),
  permissions: z.object({
    canMerge: z.boolean(),
    canSend: z.boolean(),
    canTerminal: z.boolean(),
    reasons: z.object({ merge: reason.optional(), send: reason.optional(), terminal: reason.optional() }).default({}),
  }),
  live: z.object({ workspaceId: z.string().min(1) }).optional(),
}).refine(summary => summary.countsKnown === undefined || summary.reviewRef !== undefined, { message: 'Versioned summary lacks its reference field' }) satisfies z.ZodType<ReviewSummary>

const fileSchema = z.object({
  path: z.string().min(1),
  previousPath: z.string().min(1).optional(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed', 'unavailable']),
  additions: count.nullable(),
  deletions: count.nullable(),
  countsKnown: z.boolean().optional(),
  fileVersion: reviewedFileChange.shape.fileVersion.optional(),
  format: z.enum(['unloaded', 'text', 'binary', 'too_large', 'unavailable']).optional(),
  viewed: z.boolean().optional(),
  patch: z.string().nullable(),
  tooLarge: z.boolean().optional(),
  comments: count.default(0),
}) satisfies z.ZodType<ReviewFile>
const sentCommentSchema = z.object({ id: z.string().min(1), path: z.string().min(1), line: z.number().int().positive(), side: z.enum(['old', 'new']), body: z.string(), author: z.string(), sentAt: z.string().min(1) })
export const fileReadSchema = z.object({ reviewRef: taskReviewRef.optional(), file: fileSchema, comments: z.array(sentCommentSchema).default([]), nextCommentsCursor: z.string().min(1).optional() }) satisfies z.ZodType<ReviewFileRead>

const diffSchema = z.object({
  source: z.object({ kind: z.enum(['machine', 'checkpoint', 'commit', 'pr']), at: z.string().min(1), reclaimed: z.boolean(), stale: z.boolean().optional() }),
  live: z.boolean(),
  base: z.string().nullable(),
  head: z.string().nullable(),
  reviewRef: taskReviewRef.nullable().optional(),
  availability: diffSnapshot.shape.availability.optional(),
  reason: diffSnapshot.shape.reason.optional(),
  boardRevision: count.nullable().optional(),
  files: z.array(fileSchema),
  empty: z.boolean(),
  nextCursor: z.string().min(1).optional(),
}) satisfies z.ZodType<ReviewDiff>

export const readSchema = z.object({ summary: summarySchema, diff: diffSchema }) satisfies z.ZodType<ReviewRead>
export const checksSchema = z.array(z.object({ id: z.string().min(1), name: z.string().min(1), status: z.enum(['failed', 'passed', 'pending', 'neutral']), logExcerpt: z.string().optional(), logUrl: z.string().url().optional() })) satisfies z.ZodType<ReviewCheck[]>
export const checkObservationSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('complete'), reviewRef: taskReviewRef, checks: checksSchema }),
  z.object({ state: z.literal('not_applicable'), reviewRef: taskReviewRef, counts: z.null(), checks: z.array(z.never()).length(0) }),
])

export function sameReviewReference(requested: TaskReviewRef, returned: TaskReviewRef | null | undefined): boolean {
  return returned?.snapshotId === requested.snapshotId && returned.sourceVersion === requested.sourceVersion
}
