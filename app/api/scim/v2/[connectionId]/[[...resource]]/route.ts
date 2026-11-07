import { pool } from '@/lib/db'
import { ScimStore } from '@/lib/enterprise/scim-store'
import { createScimHandler } from '@/lib/enterprise/scim-http'
import { auditDirectoryGroup, synchronizeDirectoryUser } from '@/lib/enterprise/lifecycle'

export const runtime = 'nodejs'
const handle = createScimHandler(new ScimStore(pool, synchronizeDirectoryUser, auditDirectoryGroup))
async function route(request: Request, context: { params: Promise<{ connectionId: string; resource?: string[] }> }) {
  const { connectionId, resource = [] } = await context.params
  return handle(request, connectionId, resource)
}
export { route as GET, route as POST, route as PUT, route as PATCH, route as DELETE }
