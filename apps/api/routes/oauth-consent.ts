import { eq } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { oauthClients } from '@/lib/db/schema'

/** Same projection and session boundary as the original consent server page.
 * The OAuth provider still validates/authorizes the actual consent action. */
export async function GET(request: Request): Promise<Response> {
  const headers = { 'cache-control': 'no-store', vary: 'Cookie' }
  if (request.headers.has('authorization')) return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
  const query = new URL(request.url).searchParams
  const clientId = query.get('client_id')
  if ((clientId?.length ?? 0) > 512 || query.getAll('client_id').length > 1) return Response.json({ error: 'Invalid client' }, { status: 400, headers })
  const [client] = clientId ? await db.select({ name: oauthClients.name, uri: oauthClients.uri }).from(oauthClients).where(eq(oauthClients.clientId, clientId)).limit(1) : []
  return Response.json({ clientName: client?.name ?? null, clientUri: client?.uri ?? null, account: session.user.email }, { headers })
}
