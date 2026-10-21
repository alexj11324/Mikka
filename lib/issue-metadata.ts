import { z } from 'zod'
import type { JSONContent } from '@tiptap/core'

export const LABEL_COLORS = ['violet', 'blue', 'green', 'yellow', 'red', 'gray'] as const
export const labelSchema = z.object({ name: z.string().trim().min(1).max(40), color: z.enum(LABEL_COLORS) })
export const pullRequestSchema = z.object({
  url: z.url().max(500).refine(value => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*\/?$/.test(value), '请输入有效的 GitHub PR 链接。'),
  state: z.enum(['open', 'merged', 'closed']),
})
export const assigneeSchema = z.object({ kind: z.enum(['member', 'agent']), id: z.string().min(1).max(128), name: z.string().max(200), image: z.string().nullable() })
export const metadataSchema = z.object({
  number: z.number().int().positive().optional(),
  assignee: assigneeSchema.nullable().default(null),
  project: z.string().trim().max(100).nullable().default(null),
  labels: z.array(labelSchema).max(12).default([]),
  pullRequests: z.array(pullRequestSchema).max(10).default([]),
})
export type IssueMetadata = z.infer<typeof metadataSchema>
export type IssueLabel = z.infer<typeof labelSchema>
export type IssuePullRequest = z.infer<typeof pullRequestSchema>

export function readIssueMetadata(content: JSONContent): IssueMetadata {
  const parsed = metadataSchema.safeParse(content.attrs?.orvilo)
  return parsed.success ? parsed.data : { assignee: null, project: null, labels: [], pullRequests: [] }
}

export function withIssueMetadata(content: JSONContent, metadata: IssueMetadata): JSONContent {
  return { ...content, attrs: { ...content.attrs, orvilo: metadata } }
}

export function issueWithMetadata<T extends { content: JSONContent }>(issue: T) {
  return { ...issue, metadata: readIssueMetadata(issue.content) }
}
