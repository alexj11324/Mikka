import { taskReviewHttp } from '@/lib/coding-workspace/task-review/http'
import { readTaskReviewChecks } from '@/lib/coding-workspace/task-review/checks'

export const dynamic = 'force-dynamic'
export const maxDuration = 30
export const GET = taskReviewHttp(readTaskReviewChecks)
