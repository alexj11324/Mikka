import { withDeviceRoute } from '@/lib/device-route'
import { NextResponse } from '@/lib/server-runtime/server'
import { deviceReportSchema, type DeviceReportResult } from '@mikka/protocol/device'
import { pool, db } from '@/lib/db'
import { ensureDeviceAgents } from '@/lib/device-agents'
import { authenticateDevice, hashDeviceToken, linkDeviceToken } from '@/lib/device-link'
import { pendingDeviceCommands } from '@/lib/device-management'
import { renewCloudDeviceToken } from '@/lib/computer/cloud-device'
import { daemonVersions } from '@/lib/daemon-release'
import { ownerListChanged } from '@/lib/live/lists'
import { withDeviceReportBody } from '@/lib/device-report-body'
import { PluginError } from '@/lib/plugins/contracts'


const headers = { 'Cache-Control': 'private, no-store' }

/**
 * `POST /v1/devices/:deviceId/report`: what changed on the device, sent once
 * when it changes and once after its session opens (decision 2026-11-17-2215):
 * command receipts, a failed automatic update, harnesses, device type and
 * computer use. The answer carries the oldest pending device command and the
 * daemon releases, and, for a cloud worker that asks an hour before its token
 * expires, the next token. It renews no lease and records no presence: both
 * follow the device session (lib/device-session.ts).
 *
 * A removed device's credential reaches only this route, and only to collect
 * its uninstall command and deliver the receipt (lib/device-link.ts).
 */
async function handlePOST(request: Request, body: unknown, { params }: { params: Promise<{ deviceId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { deviceId } = await params
  if (caller.removingDeviceId === deviceId) {
    const parsed = deviceReportSchema.safeParse(body)
    if (!parsed.success) return NextResponse.json({ error: 'Invalid report.' }, { status: 400, headers })
    if (parsed.data.mcpChecks?.length) return NextResponse.json({ error: 'Unknown device.' }, { status: 404, headers })
    // No harness refresh, credential or other command after removal.
    const result: DeviceReportResult = { deviceCommands: await pendingDeviceCommands(deviceId, parsed.data.completedDeviceCommands ?? []) }
    return NextResponse.json(result, { headers })
  }
  // Also records this credential as the device's, so removing it revokes the credential.
  if (!await linkDeviceToken(caller, deviceId)) return NextResponse.json({ error: 'Unknown device.' }, { status: 404, headers })
  const parsed = deviceReportSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid report.' }, { status: 400, headers })
  if (parsed.data.mcpChecks?.length) {
    try {
      const { mcpDeviceChecks } = await import('@/lib/plugins/runtime')
      for (const receipt of parsed.data.mcpChecks) await mcpDeviceChecks.complete(caller.userId, deviceId, receipt)
    } catch (error) {
      if (!(error instanceof PluginError)) throw error
      return NextResponse.json({ error: error.code }, { status: error.status, headers })
    }
  }
  const { harnesses, deviceType, updateFailure, computerUse } = parsed.data
  // Only what the report carries changes; one statement says whether anything a person sees changed.
  const { rows: [row] } = await pool.query<{ ownerId: string; changed: boolean; harnessesChanged: boolean }>(`
    WITH prior AS (SELECT id, "deviceType", "updateFailure", "computerUse", harnesses FROM devices WHERE id=$1 FOR UPDATE)
    UPDATE devices d SET "deviceType"=COALESCE($2::text, d."deviceType"),
      "updateFailure"=CASE WHEN $3::boolean THEN $4::jsonb ELSE d."updateFailure" END,
      "computerUse"=COALESCE($5::jsonb, d."computerUse"), "updatedAt"=now()
    FROM prior WHERE d.id=prior.id
    RETURNING d."ownerId",
      (prior."deviceType" IS DISTINCT FROM d."deviceType" OR prior."updateFailure" IS DISTINCT FROM d."updateFailure"
        OR prior."computerUse" IS DISTINCT FROM d."computerUse") AS changed,
      ($6::jsonb IS NOT NULL AND prior.harnesses IS DISTINCT FROM $6::jsonb) AS "harnessesChanged"`,
  [deviceId, deviceType ?? null, updateFailure !== undefined, updateFailure == null ? null : JSON.stringify(updateFailure),
    computerUse ? JSON.stringify(computerUse) : null, harnesses ? JSON.stringify(harnesses) : null])
  if (!row) return NextResponse.json({ error: 'Unknown device.' }, { status: 404, headers })
  // The execution identities follow the harnesses. They are stored only once
  // those exist, so a failed check leaves them changed for the next report.
  if (harnesses) {
    await ensureDeviceAgents(pool, caller.userId, deviceId, harnesses, { reported: true })
    if (row.harnessesChanged) await pool.query(`UPDATE devices SET harnesses=$2::jsonb WHERE id=$1`, [deviceId, JSON.stringify(harnesses)])
  }
  if (row.changed || row.harnessesChanged) await ownerListChanged(db, caller.userId, ['device_list'])
  const result: DeviceReportResult = {
    deviceCommands: await pendingDeviceCommands(deviceId, parsed.data.completedDeviceCommands ?? [], parsed.data.failedDeviceCommands ?? []),
    daemonVersions: await daemonVersions(),
  }
  // A cloud worker asks once, an hour before its token expires: a deadline, not a poll.
  if (parsed.data.rotateCloudCredential && caller.scopeDeviceId === deviceId && caller.scopeWorkspaceId) {
    const credential = await renewCloudDeviceToken(pool, { userId: caller.userId, workspaceId: caller.scopeWorkspaceId, deviceId, tokenId: caller.tokenId }).catch(() => null)
    if (credential) {
      const { rows: [token] } = await pool.query<{ expiresAt: Date }>(`SELECT "expiresAt" FROM device_tokens WHERE "tokenHash"=$1`, [hashDeviceToken(credential)])
      result.cloudCredential = credential
      if (token?.expiresAt) result.cloudCredentialExpiresAt = token.expiresAt.toISOString()
    }
  }
  return NextResponse.json(result, { headers })
}

export const POST = withDeviceReportBody(withDeviceRoute(handlePOST))
