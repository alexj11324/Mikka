import { z } from 'zod'

export const TASK_PRESENTATION_PARAM = 'presentation'
export const TASK_PRESENTATION_VERSION = 1
export const TASK_REFRESH_FAILURE_HEADER = 'x-mikka-task-refresh-failure'

const failureReport = z.strictObject({
  stage: z.enum(['list', 'workspace', 'presentation']),
  reason: z.enum(['credentials', 'network', 'timeout', 'invalid_response', 'http']),
  status: z.number().int().min(300).max(599).optional(),
  traceId: z.string().regex(/^[0-9a-f]{32}$/).optional(),
})

export type TaskRefreshFailure = z.infer<typeof failureReport>

export function readTaskRefreshFailure(raw: string | null): TaskRefreshFailure | undefined {
  if (!raw || raw.length > 160) return
  try {
    const result = failureReport.safeParse(JSON.parse(raw))
    if (result.success && (result.data.reason === 'http') === (result.data.status !== undefined)) return result.data
  } catch { /* A malformed diagnostic must never affect the task read. */ }
}
