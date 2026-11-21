import { z } from 'zod'

export const deviceConcurrencyInput = z.strictObject({ maxConcurrentRuns: z.number().int().min(1).max(64) })
