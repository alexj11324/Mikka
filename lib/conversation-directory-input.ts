import { z } from 'zod'

export const archiveIdleDays = [0, 3, 7, 14, 30, 90] as const

export const directoryInput = z.strictObject({
  search: z.string().trim().max(120).default(''),
  state: z.enum(['all', 'working', 'waiting', 'idle', 'failed']).default('all'),
  archived: z.boolean().default(false),
  botId: z.uuid().optional(),
  cursor: z.object({ pinned: z.boolean(), at: z.iso.datetime({ precision: 6 }), id: z.uuid() }).optional(),
})
export type DirectoryInput = z.input<typeof directoryInput>
export type DirectoryState = Exclude<z.output<typeof directoryInput>['state'], 'all'>
