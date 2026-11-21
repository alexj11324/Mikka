import { z } from 'zod'

const workspaceSlugSchema = z.string().trim().toLowerCase().min(3).max(64).regex(/^[a-z0-9]([a-z0-9-]{1,62}[a-z0-9])$/)

export const updateWorkspaceInput = z.strictObject({
  name: z.string().trim().min(1).max(120).optional(),
  slug: workspaceSlugSchema.optional(),
  icon: z.string().max(400_000).nullable().optional(),
  taskPrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,4}$/).nullable().optional(),
  parallelSubagents: z.number().int().min(1).max(16).optional(),
  nestDepth: z.number().int().min(1).max(8).optional(),
  newWorkVisibility: z.enum(['inherit', 'members', 'private']).optional(),
  workspaceWorkVisibility: z.enum(['members', 'private']).optional(),
  allowPrivate: z.boolean().optional(),
})

export type UpdateWorkspaceInput = z.input<typeof updateWorkspaceInput>
