import { withRequestLog } from '@/lib/request-log'
import { reviewTerminal } from '@/lib/coding-workspace/terminal/http'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

export const GET = withRequestLog('/api/tasks/[taskId]/review/terminal', async (request, { params }: { params: Promise<{ taskId: string }> }) =>
  reviewTerminal.stream(request, (await params).taskId))
export const DELETE = withRequestLog('/api/tasks/[taskId]/review/terminal', async (request, { params }: { params: Promise<{ taskId: string }> }) =>
  reviewTerminal.close(request, (await params).taskId))
