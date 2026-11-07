import { serverInfoResponse } from '@/lib/server-info'
import { withRequestLog } from '@/lib/request-log'

export const dynamic = 'force-dynamic'
export const GET = withRequestLog('/api/server', (request: Request) => serverInfoResponse(request))
