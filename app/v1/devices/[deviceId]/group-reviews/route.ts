import { withDeviceAuthorization } from '@/lib/device-link'
import { authenticateDevice } from '@/lib/device-link'
import { pool } from '@/lib/db'
import { workspaceDb } from '@/lib/workspace-db'
import { withGroupWorkerAuthority } from '@/lib/group-worker-authority'
import { ReviewFailure } from '@/lib/group-review-access'
import { handleGroupWorkerRequest } from '@/lib/group-worker-route'
/** Dedicated JSON-only worker path: existing device auth; no MCP, repository,
 * credentials or private runtime assignment is returned. */
async function handlePOST(request:Request,{params}:{params:Promise<{deviceId:string}>}) {
  const caller=await authenticateDevice(request)
  if(!caller)return Response.json({error:'unauthorized'},{status:401})
  const {deviceId}=await params
  try{return await handleGroupWorkerRequest(request,deviceId,{pool,directory:async()=>false,withDirectory:fn=>withGroupWorkerAuthority(workspaceDb.$client,caller,deviceId,fn),authenticate:async()=>caller,onClaim:async(client,runId)=>{
      await client.query('UPDATE agent_runs SET "deviceTokenId"=$2 WHERE id=$1 AND "userId"=$3',[runId,caller.tokenId,caller.userId])
    }})}
  catch(error){if(error instanceof ReviewFailure)return Response.json({error:error.code},{status:error.status});throw error}
}

export const POST = withDeviceAuthorization(handlePOST)
