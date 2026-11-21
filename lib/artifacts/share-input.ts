import { z } from 'zod'

export const artifactShareVisibilityInput = z.enum(['private', 'workspace', 'link'])
export const artifactShareInput = z.tuple([z.uuid(), artifactShareVisibilityInput.optional()])
