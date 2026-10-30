import 'server-only'
// Bearer-token authentication for API routes. NOT WIRED: no route imports this
// yet (plan item 3 ships create/list/revoke only). Wiring it needs a separate
// review of which routes accept tokens and with what scope.
import { requireWorkspace } from '@/lib/workspace-access'
import { workspaceDb } from '@/lib/workspace-db'
import { bearerToken } from './format'
import { verifyPersonalAccessToken, type TokenPrincipal } from './store'

/** The token's owner when the request carries a valid token and they are still an active member; else null. */
export async function authenticatePersonalAccessToken(request: Request): Promise<TokenPrincipal | null> {
  const token = bearerToken(request.headers.get('authorization'))
  if (!token) return null
  const principal = await verifyPersonalAccessToken(token)
  if (!principal) return null
  try {
    await workspaceDb.transaction(tx => requireWorkspace(tx, principal.workspaceId, principal.userId))
  } catch { return null }
  return principal
}
