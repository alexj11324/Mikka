import { authenticateDevice } from '@/lib/device-link'
import { pool } from '@/lib/db'
import { directory } from '@/lib/group-conversations-route'
import { handleGroupWorkerRequest } from '@/lib/group-worker-route'
/** Dedicated JSON-only worker path: existing device auth; no MCP, repository,
 * credentials or private runtime assignment is returned. */
export async function POST(request:Request,{params}:{params:Promise<{deviceId:string}>}) {
  return handleGroupWorkerRequest(request,(await params).deviceId,{pool,directory,authenticate:authenticateDevice})
}
