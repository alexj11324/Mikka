import { taskReviewHttp } from '@/lib/coding-workspace/task-review/http'
import { readTaskReviewSummary } from '@/lib/coding-workspace/task-review/read'

export const dynamic = 'force-dynamic'
export const GET = taskReviewHttp(readTaskReviewSummary)
