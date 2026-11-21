import { withRequestLog } from '@/lib/request-log'
import { reviewTerminal } from '@/lib/coding-workspace/terminal/http'


export const POST = withRequestLog('/api/tasks/[taskId]/review/terminal/resize', async (request, { params }: { params: Promise<{ taskId: string }> }) =>
  reviewTerminal.resize(request, (await params).taskId))
