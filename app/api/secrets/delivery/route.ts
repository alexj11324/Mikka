import { auth } from '@/lib/auth'
import { freshSessionRoute } from '@/lib/fresh-session'
import { auditRequestContext } from '@/lib/audit/events'
import { secretAuditHook } from '@/lib/secrets/audit'
import { createSecretDeliveryHandler } from '@/lib/secrets/delivery-http'
import { listUserSecrets, replaceUserSecret } from '@/lib/secrets/user-store'
import { listWorkspaceSecrets, replaceWorkspaceSecret } from '@/lib/secrets/store'

export const dynamic = 'force-dynamic'

const handle = createSecretDeliveryHandler({
  getSession: input => auth.api.getSession(input),
  listPersonal: actor => listUserSecrets(actor.id),
  listWorkspace: (actor, workspaceId) => listWorkspaceSecrets(actor.id, workspaceId),
  replacePersonal: (actor, input) => replaceUserSecret(actor.id, input),
  replaceWorkspace: (actor, workspaceId, input, request) => replaceWorkspaceSecret(actor.id, workspaceId, input,
    secretAuditHook(actor, auditRequestContext(request.headers))),
})

// Both metadata reads and credential-delivery changes require a fresh human
// session. The factory rejects delegated tokens and enforces exact origins.
export const GET = freshSessionRoute(handle)
export const PATCH = freshSessionRoute(handle)
