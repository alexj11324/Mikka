import { z } from 'zod'

export const repositorySchema = z.string().max(201).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  .refine(value => value.split('/').every(part => part !== '.' && part !== '..' && !part.startsWith('-')))
