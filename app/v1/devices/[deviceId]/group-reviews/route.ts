import { authenticateDevice } from '@/lib/device-link'
import { pool } from '@/lib/db'
import { workspaceDb } from '@/lib/workspace-db'
import { withGroupWorkerAuthority } from '@/lib/group-worker-authority'
import { ReviewFailure } from '@/lib/group-review-access'
import { handleGroupWorkerRequest } from '@/lib/group-worker-route'
/** Dedicated JSON-only worker path: existing device auth; no MCP, repository,
 * credentials or private runtime assignment is returned. */
export async function POST(request:Request,{params}:{params:Promise<{deviceId:string}>}) {
  const caller=await authenticateDevice(request)
  if(!caller)return Response.json({error:'unauthorized'},{status:401})
  const {deviceId}=await params
  try{return await withGroupWorkerAuthority(workspaceDb.$client,caller,deviceId,directory=>
    handleGroupWorkerRequest(request,deviceId,{pool,directory,authenticate:async()=>caller}))}
  catch(error){if(error instanceof ReviewFailure)return Response.json({error:error.code},{status:error.status});throw error}
}
