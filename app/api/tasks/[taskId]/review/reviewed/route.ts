import { taskReviewHttp } from '@/lib/coding-workspace/task-review/http'
import { markTaskReviewFiles } from '@/lib/coding-workspace/task-review/reviewed'

export const dynamic = 'force-dynamic'
export const POST = taskReviewHttp(markTaskReviewFiles)
