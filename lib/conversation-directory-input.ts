import { z } from 'zod'

export const directoryInput = z.strictObject({
  search: z.string().trim().max(120).default(''),
  state: z.enum(['all', 'working', 'waiting', 'idle', 'failed']).default('all'),
  archived: z.boolean().default(false),
  botId: z.uuid().optional(),
  cursor: z.object({ pinned: z.boolean(), at: z.iso.datetime({ precision: 6 }), id: z.uuid(), kind: z.enum(['run', 'chat']).optional() }).optional(),
})
export type DirectoryInput = z.input<typeof directoryInput>
export type DirectoryState = Exclude<z.output<typeof directoryInput>['state'], 'all'>

export function directoryConversationKey(row: { kind: 'run' | 'chat'; id: string }) {
  return row.kind + ':' + row.id
}
