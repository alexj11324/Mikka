import { accountApi } from '@/lib/interop/http'
import { deleteAgentGrant } from '@/lib/interop/grants'

type Context = { params: Promise<{ kind: string; resourceId: string; subjectKind: string; subjectId: string }> }

/** Revoke one Bot, run or service grant. Owner or Workspace admin. */
export const DELETE = async (request: Request, { params }: Context) => {
  const { kind, resourceId, subjectKind, subjectId } = await params
  return accountApi(request, 'grants:write', manager => deleteAgentGrant(manager, kind, resourceId, subjectKind, subjectId))
}
