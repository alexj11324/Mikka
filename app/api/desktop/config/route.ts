import { desktopConfig } from '@/lib/desktop-rpc/bootstrap'
import { withRequestLog } from '@/lib/request-log'

export const dynamic = 'force-dynamic'
export const GET = withRequestLog('/api/desktop/config', async () =>
  Response.json(await desktopConfig(), { headers: { 'Cache-Control': 'no-store' } }))
