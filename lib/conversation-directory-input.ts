import { z } from 'zod'
import { pullRequestSchema } from './issue-metadata'

export const archiveIdleDays = [0, 3, 7, 14, 30, 90] as const

// Released clients send only the UUID. New clients retain the object's kind.
export const conversationTargetInput = z.union([z.uuid(), z.strictObject({ kind: z.enum(['run', 'chat']), id: z.uuid() })])
export type ConversationTarget = z.infer<typeof conversationTargetInput>

export const directoryInput = z.strictObject({
  search: z.string().trim().max(120).default(''),
  state: z.enum(['all', 'working', 'waiting', 'idle', 'failed']).default('all'),
  archived: z.union([z.boolean(), z.literal('any')]).default(false),
  pullState: z.enum(['all', 'linked', 'open', 'draft', 'merged', 'closed']).default('all'),
  botId: z.uuid().optional(),
  /** Threads of tasks in this workspace project (workspace_project_tasks). */
  projectId: z.uuid().optional(),
  /** Threads with a pull request opened at or after this instant. */
  since: z.iso.datetime({ offset: true }).optional(),
  cursor: z.object({ pinned: z.boolean(), at: z.iso.datetime({ precision: 6 }), id: z.uuid(), kind: z.enum(['run', 'chat']).optional() }).optional(),
})
export type DirectoryInput = z.input<typeof directoryInput>
export type DirectoryState = Exclude<z.output<typeof directoryInput>['state'], 'all'>

export function directoryConversationKey(row: { kind?: 'run' | 'chat'; id: string }) {
  return (row.kind ?? 'run') + ':' + row.id
}

export type DirectoryTaskLink = { id: string; identifier: string | null; title: string }

/** Older servers and Run conversations expose a single issued Task number. */
export function directoryTaskNumbers(row: { linkedTasks?: DirectoryTaskLink[]; issueId: string | null; identifier: string | null }) {
  const tasks = row.linkedTasks ?? [{ id: row.issueId, identifier: row.identifier }]
  return tasks.flatMap(({ id, identifier }) => identifier ? [{ key: id ?? identifier, identifier }] : [])
}

/** A delivered pull request as the directory lists it: the task's record plus who opened it, when, and from which branch. */
export const directoryPullSchema = pullRequestSchema.extend({
  head: z.string().max(1024).optional(),
  headSha: z.string().regex(/^[a-f0-9]{40,64}$/i).optional(),
  author: z.string().max(100).optional(),
  createdAt: z.iso.datetime({ offset: true }).optional(),
})
export type DirectoryPull = z.infer<typeof directoryPullSchema>

export interface ConversationDirectoryPage {
  items: {
    pulls: DirectoryPull[]; taskTitle: string | null; kind: 'run' | 'chat'; id: string; issueId: string | null; identifier: string | null; title: string
    linkedTasks?: DirectoryTaskLink[]
    state: DirectoryState; at: string; pinned: boolean; unread?: boolean
  }[]
  cursor: NonNullable<DirectoryInput['cursor']> | null
}
