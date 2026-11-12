import { withRequestLog } from '@/lib/request-log'
import { reviewTerminal } from '@/lib/coding-workspace/terminal/http'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export const POST = withRequestLog('/api/tasks/[taskId]/review/terminal/input', async (request, { params }: { params: Promise<{ taskId: string }> }) =>
  reviewTerminal.input(request, (await params).taskId))
