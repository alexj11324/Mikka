import { cronUnauthorized } from '@/lib/cron-auth'
import { cronJob } from '@/lib/background'
import { privateHeaders } from '@/lib/credentials/http'
async function handleGET(request: Request) {
  const refused = await cronUnauthorized(request); if (refused) return refused
  // Retention hold: no automatic database deletion is authorized.
  return Response.json({ disabled: true }, { headers: privateHeaders })
}

export const GET = cronJob('credential-cleanup', handleGET)
