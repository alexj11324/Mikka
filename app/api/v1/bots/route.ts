import { interopApi } from '@/lib/interop/http'
import { listInteropBots } from '@/lib/interop/bots'

/** Bots of the credential's Workspace it may discover (decision 2026-11-19-2200). */
export const GET = (request: Request) => interopApi(request, 'bots:read', async principal => ({ bots: await listInteropBots(principal) }))
