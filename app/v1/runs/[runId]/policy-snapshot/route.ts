import { z } from 'zod'
import { withDeviceRoute } from '@/lib/device-route'
import { authenticateDevice } from '@/lib/device-link'
import { pool } from '@/lib/db'
import { AgentToolApprovalStore } from '@/lib/agent-tool-approval/store'
import { issuePolicySnapshot, policyDistributionContext, requestPolicyIssuer } from '@/lib/agent-tool-approval/policy-distribution'
import { signedPolicySnapshotSchema } from '@mikka/protocol/policy-snapshot'
import { verifyPolicySnapshot } from '@mikka/protocol/node-policy-snapshot'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const headers = {'cache-control':'no-store'}
async function handle(request: Request, {params}: {params:Promise<{runId:string}>}) {
  const caller = await authenticateDevice(request)
  if (!caller) return Response.json({error:'Unauthorized'},{status:401,headers})
  const {runId} = await params
  const schema = z.strictObject({deviceId:z.uuid(),snapshot:signedPolicySnapshotSchema})
  const input = request.method === 'GET' ? z.strictObject({deviceId:z.uuid()}).safeParse({deviceId:new URL(request.url).searchParams.get('deviceId')}) : schema.safeParse(await request.json().catch(()=>null))
  if (!z.uuid().safeParse(runId).success || !input.success || (caller.scopeDeviceId && caller.scopeDeviceId !== input.data.deviceId)) return Response.json({error:'invalidRequest'},{status:400,headers})
  try {
    const snapshot = 'snapshot' in input.data ? signedPolicySnapshotSchema.parse(input.data.snapshot) : undefined
    const current = await new AgentToolApprovalStore(pool).policyDistribution({userId:caller.userId,deviceId:input.data.deviceId},runId,snapshot?.payload.revision)
    if (caller.scopeWorkspaceId && !current.workspaceIds.includes(caller.scopeWorkspaceId)) throw Error('policyScopeUnavailable')
    const context = policyDistributionContext(requestPolicyIssuer(request),caller.userId,input.data.deviceId,runId,current)
    if (!snapshot) return Response.json(context,{headers})
    // Verify the original server signature and retain its exact final composed
    // policy. The current CLI revision alone cannot reconstruct Factory/computer grants.
    const prior = verifyPolicySnapshot(snapshot,context,{runId,deviceId:input.data.deviceId,revision:current.revision},{allowExpired:true})
    return Response.json(issuePolicySnapshot(context,prior.payload.policy),{headers})
  } catch { return Response.json({error:'policySnapshotUnavailable'},{status:409,headers}) }
}
export const GET = withDeviceRoute(handle)
export const POST = withDeviceRoute(handle)
