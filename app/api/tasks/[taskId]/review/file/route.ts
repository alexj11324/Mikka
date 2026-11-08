import { taskReviewHttp } from '@/lib/coding-workspace/task-review/http'
import { readTaskReviewFile } from '@/lib/coding-workspace/task-review/read'

export const dynamic = 'force-dynamic'
export const maxDuration = 30
export const GET = taskReviewHttp(readTaskReviewFile)
