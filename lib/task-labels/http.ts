import { governanceResponse } from '@/lib/governance/http'
import { TaskLabelConflict } from './store'

export function taskLabelsResponse(work: () => Promise<Response | unknown>) {
  return governanceResponse(async () => {
    try { return await work() }
    catch (error) {
      if (!(error instanceof TaskLabelConflict)) throw error
      return Response.json({ error: { code: 'task_label_conflict', detail: error.detail } }, { status: 409, headers: { 'cache-control': 'private, no-store' } })
    }
  })
}
