import { withRequestLog } from '@/lib/request-log'
import { reviewTerminal } from '@/lib/coding-workspace/terminal/http'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

export const GET = withRequestLog('/api/tasks/[id]/review/terminal', async (request, { params }: { params: Promise<{ id: string }> }) =>
  reviewTerminal.stream(request, (await params).id))
export const DELETE = withRequestLog('/api/tasks/[id]/review/terminal', async (request, { params }: { params: Promise<{ id: string }> }) =>
  reviewTerminal.close(request, (await params).id))
