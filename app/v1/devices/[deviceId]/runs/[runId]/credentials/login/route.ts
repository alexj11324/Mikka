import { withDeviceRoute } from '@/lib/device-route'
import { z } from 'zod'
import { authenticateDevice, ownedDevice } from '@/lib/device-link'
import { pool } from '@/lib/db'
import { login } from '@/lib/credentials/runtime'
import { CredentialError } from '@/lib/credentials/contracts'
import { credentialBody, credentialFailure, privateHeaders } from '@/lib/credentials/http'
export const maxDuration = 60
async function handlePOST(request: Request, context: { params: Promise<{ deviceId: string; runId: string }> }) {
  try {
    const { deviceId, runId } = await context.params
    if (!z.uuid().safeParse(deviceId).success || !z.uuid().safeParse(runId).success) throw new CredentialError('credential_denied', 404)
    const principal = await authenticateDevice(request)
    if (!principal || (principal.scopeDeviceId && principal.scopeDeviceId !== deviceId)) throw new CredentialError('credential_auth_required', 401)
    const device = await ownedDevice(deviceId, principal.userId)
    if (!device?.enabled) throw new CredentialError('credential_denied', 404)
    const run = (await pool.query(`SELECT r."botId",b."workspaceId" FROM agent_runs r JOIN bots b ON b.id=r."botId" AND b."ownerId"=r."userId" WHERE r.id=$1 AND r."userId"=$2 AND r."deviceId"=$3`, [runId, principal.userId, deviceId])).rows[0]
    if (!run || (principal.scopeWorkspaceId && principal.scopeWorkspaceId !== run.workspaceId)) throw new CredentialError('credential_denied', 404)
    const parsed = z.object({ site: z.string().max(2048), forcePassword: z.boolean().optional() }).strict().safeParse(await credentialBody(request))
    if (!parsed.success) throw new CredentialError('credential_submission_invalid', 400)
    return Response.json(await login({ userId: principal.userId, workspaceId: run.workspaceId, botId: run.botId, runId }, parsed.data.site, undefined, { forcePassword: parsed.data.forcePassword }), { headers: privateHeaders })
  } catch (error) { return credentialFailure(error) }
}

export const POST = withDeviceRoute(handlePOST)
