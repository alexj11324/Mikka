import { taskReviewHttp } from '@/lib/coding-workspace/task-review/http'
import { mergeTaskReview } from '@/lib/coding-workspace/task-review/merge'

export const dynamic = 'force-dynamic'
export const maxDuration = 60
export const POST = taskReviewHttp(mergeTaskReview)
