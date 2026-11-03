import { cronUnauthorized } from '@/lib/cron-auth'
import { sweepAccountDeletions } from '@/lib/account/deletion-jobs'
import { cleanupChatFiles } from '@/lib/chat-attachments/store'
export const runtime = 'nodejs'
export const maxDuration = 60
const headers = { 'cache-control': 'no-store' }
export async function GET(request: Request) {
  const refused = await cronUnauthorized(request); if (refused) return refused
  try { const result = await sweepAccountDeletions(); const attachments = await cleanupChatFiles(); return Response.json({ ...result, attachments }, { headers }) }
  catch { return Response.json({ error: 'accountDeletionUnavailable' }, { status: 503, headers }) }
}
