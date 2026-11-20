import { accountApi, interopBody } from '@/lib/interop/http'
import { listAgentGrants, putAgentGrant } from '@/lib/interop/grants'

type Context = { params: Promise<{ kind: string; resourceId: string }> }

/** Bot, run and service grants on one thread, artifact, Bot, task or Bot chat. Owner or Workspace admin. */
export const GET = async (request: Request, { params }: Context) => {
  const { kind, resourceId } = await params
  return accountApi(request, 'grants:read', manager => listAgentGrants(manager, kind, resourceId))
}

/** Create or replace one subject's grant. Only the resource's owner (`canManageAccess`). */
export const PUT = async (request: Request, { params }: Context) => {
  const { kind, resourceId } = await params
  return accountApi(request, 'grants:write', async manager => ({ grant: await putAgentGrant(manager, kind, resourceId, await interopBody(request)) }))
}
