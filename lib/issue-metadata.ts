import { z } from 'zod'
import type { JSONContent } from '@tiptap/core'

export const LABEL_COLORS = ['violet', 'blue', 'green', 'yellow', 'red', 'gray'] as const
export const labelSchema = z.object({ name: z.string().trim().min(1).max(40), color: z.enum(LABEL_COLORS) })
export const pullRequestSchema = z.object({
  url: z.url().max(500).refine(value => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*\/?$/.test(value), 'issueMetadataInvalid'),
  state: z.enum(['open', 'draft', 'merged', 'closed']),
  title: z.string().max(256).optional(),
  /** Lines added and removed, as GitHub last reported them; absent on PRs stored before they were recorded. */
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
})
export const assigneeSchema = z.object({ kind: z.enum(['member', 'agent']), id: z.string().min(1).max(128), name: z.string().max(200), image: z.string().nullable() })
/** Execution delegation never grants task access or changes the human assignee. */
export const delegateSchema = z.object({ kind: z.enum(['agent', 'bot', 'profile']), id: z.string().min(1).max(128), name: z.string().max(200), image: z.string().nullable() })
/** The person's say on 受阻 (lib/task-blocked.ts): flagged, or cleared for the thread `runId`. */
export const blockFlagSchema = z.object({ blocked: z.boolean(), runId: z.string().max(128).nullable() })
export const metadataSchema = z.object({
  number: z.number().int().positive().optional(),
  assignee: assigneeSchema.nullable().default(null),
  delegate: delegateSchema.nullable().default(null),
  project: z.string().trim().max(100).nullable().default(null),
  labels: z.array(labelSchema).max(12).default([]),
  pullRequests: z.array(pullRequestSchema).max(10).default([]),
  parentId: z.uuid().nullable().default(null),
  blockedByIds: z.array(z.uuid()).max(100).default([]),
  relatedIds: z.array(z.uuid()).max(100).default([]),
  duplicateOfId: z.uuid().nullable().default(null),
  block: blockFlagSchema.nullable().default(null),
  dueDate: z.iso.date().nullable().default(null),
  estimate: z.number().int().min(0).max(100).nullable().default(null),
  favoriteUserIds: z.array(z.string().max(128)).max(200).default([]),
  subscriberUserIds: z.array(z.string().max(128)).max(200).default([]),
  deletedAt: z.iso.datetime().nullable().default(null),
})
export type IssueMetadata = z.infer<typeof metadataSchema>
export type IssueLabel = z.infer<typeof labelSchema>
export type IssuePullRequest = z.infer<typeof pullRequestSchema>
export type IssueDelegate = z.infer<typeof delegateSchema>

/** Preserve old assignments without continuing to present an Agent as a person.
 * A deliberate modern delegate (including null) takes precedence over history. */
function canonicalMetadata(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const metadata = value as Record<string, unknown>
  const assignee = assigneeSchema.safeParse(metadata.assignee)
  if (!assignee.success || assignee.data.kind !== 'agent') return value
  return { ...metadata, assignee: null, delegate: Object.hasOwn(metadata, 'delegate') ? metadata.delegate : assignee.data }
}

export function issueRestoreDeadline(deletedAt: string): number {
  return Date.parse(deletedAt) + 30 * 86_400_000
}

export function readIssueMetadata(content: JSONContent): IssueMetadata {
  // `orvilo` is the pre-rename key; drizzle/0005 moves stored issues to `mikka`.
  const parsed = metadataSchema.safeParse(canonicalMetadata(content.attrs?.mikka ?? content.attrs?.orvilo))
  return parsed.success ? parsed.data : metadataSchema.parse({})
}

export function withIssueMetadata(content: JSONContent, metadata: IssueMetadata): JSONContent {
  const { orvilo: _legacy, ...attrs } = content.attrs ?? {}
  return { ...content, attrs: { ...attrs, mikka: canonicalMetadata(metadata) } }
}

export function issueWithMetadata<T extends { content: JSONContent }>(issue: T) {
  return { ...issue, metadata: readIssueMetadata(issue.content) }
}
