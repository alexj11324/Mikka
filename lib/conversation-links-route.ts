import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { workspaceDb } from '@/lib/workspace-db'
import { withExchangeReadAuthority } from '@/lib/conversation-exchange-authority'
import { handleConversationLink } from '@/lib/conversation-exchanges'

export async function respondConversationLink(request: Request, id: string) {
  const session = await auth.api.getSession({ headers: request.headers })
  const url = new URL(request.url)
  const result = await withExchangeReadAuthority(workspaceDb.$client, directory => handleConversationLink(pool, directory, {
    userId: session?.user?.id ?? null, id, method: request.method,
    origin: request.headers.get('origin'), host: request.headers.get('host') ?? url.host,
    before: url.searchParams.get('before'), limit: url.searchParams.get('limit'),
  }))
  return Response.json(result.body, { status: result.status, headers: { 'Cache-Control': 'private, no-store' } })
}
