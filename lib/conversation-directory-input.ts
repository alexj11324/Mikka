import { z } from 'zod'
import type { IssuePullRequest } from './issue-metadata'

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
  /** 查看运行: only the threads of tasks this automation's runs made. */
  automationId: z.uuid().optional(),
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

export interface ConversationDirectoryPage {
  items: {
    pulls: IssuePullRequest[]; taskTitle: string | null; kind: 'run' | 'chat'; id: string; issueId: string | null; identifier: string | null; title: string
    linkedTasks?: DirectoryTaskLink[]
    state: DirectoryState; at: string; pinned: boolean; unread?: boolean
  }[]
  cursor: NonNullable<DirectoryInput['cursor']> | null
}
