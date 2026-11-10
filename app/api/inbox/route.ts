import { auth } from '@/lib/api-auth'
import { inbox } from '@/lib/inbox/runtime'
import { handleInbox } from '@/lib/inbox/http'
export const dynamic = 'force-dynamic'
async function respond(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  return handleInbox(request, session?.user ?? null, inbox())
}
export const GET = respond
export const POST = respond
