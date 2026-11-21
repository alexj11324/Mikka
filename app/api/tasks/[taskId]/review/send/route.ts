import { taskReviewHttp } from '@/lib/coding-workspace/task-review/http'
import { sendTaskReview } from '@/lib/coding-workspace/task-review/send'

export const maxDuration = 60
export const POST = taskReviewHttp(sendTaskReview)
