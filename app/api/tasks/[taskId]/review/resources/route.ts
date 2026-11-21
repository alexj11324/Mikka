import { taskReviewHttp } from '@/lib/coding-workspace/task-review/http'
import { readTaskReviewResources } from '@/lib/coding-workspace/task-review/resources'

export const maxDuration = 30
export const GET = taskReviewHttp(readTaskReviewResources)
