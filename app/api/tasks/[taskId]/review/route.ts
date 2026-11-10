import { taskReviewHttp } from '@/lib/coding-workspace/task-review/http'
import { readTaskReview } from '@/lib/coding-workspace/task-review/read'

export const dynamic = 'force-dynamic'
export const maxDuration = 30
export const GET = taskReviewHttp(readTaskReview)
