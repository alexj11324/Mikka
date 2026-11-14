import { z } from 'zod'
import type { IssuePullRequest } from './issue-metadata'

export const archiveIdleDays = [0, 3, 7, 14, 30, 90] as const

export const directoryInput = z.strictObject({
  search: z.string().trim().max(120).default(''),
  state: z.enum(['all', 'working', 'waiting', 'idle', 'failed']).default('all'),
  archived: z.union([z.boolean(), z.literal('any')]).default(false),
  pullState: z.enum(['all', 'linked', 'open', 'draft', 'merged', 'closed']).default('all'),
  botId: z.uuid().optional(),
  cursor: z.object({ pinned: z.boolean(), at: z.iso.datetime({ precision: 6 }), id: z.uuid() }).optional(),
})
export type DirectoryInput = z.input<typeof directoryInput>
export type DirectoryState = Exclude<z.output<typeof directoryInput>['state'], 'all'>

export interface ConversationDirectoryPage {
  items: {
    pulls: IssuePullRequest[]; taskTitle: string | null; kind: 'run' | 'chat'; id: string; issueId: string | null; identifier: string | null; title: string
    state: DirectoryState; at: string; pinned: boolean; unread?: boolean
  }[]
  cursor: NonNullable<DirectoryInput['cursor']> | null
}
