import { z } from 'zod'

export const directoryInput = z.strictObject({
  search: z.string().trim().max(120).default(''),
  state: z.enum(['all', 'working', 'waiting', 'idle', 'failed']).default('all'),
  archived: z.boolean().default(false),
  botId: z.uuid().optional(),
  cursor: z.object({ pinned: z.boolean(), at: z.iso.datetime({ precision: 6 }), id: z.uuid() }).optional(),
})
export type DirectoryInput = z.input<typeof directoryInput>
export type DirectoryState = Exclude<z.output<typeof directoryInput>['state'], 'all'>

export interface ConversationDirectoryPage {
  items: {
    id: string; issueId: string | null; identifier: string | null; title: string
    state: DirectoryState; at: string; pinned: boolean; unread: boolean
  }[]
  cursor: NonNullable<DirectoryInput['cursor']> | null
}
