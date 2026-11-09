import { withDeviceRoute } from '@/lib/device-route'
import { NextResponse } from 'next/server'
import { readUnderDeviceAuthority } from '@/lib/db'
import { authenticateDevice } from '@/lib/device-link'

export const dynamic = 'force-dynamic'

/** `GET /v1/devices/:deviceId/runs?state=queued`: runs waiting for this device. */
async function handleGET(request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { deviceId } = await params
  // Credential, current ownership and queued work share one read snapshot.
  // A device with scheduling off gets no work; it stays registered.
  const result = await readUnderDeviceAuthority<{ runIds: string[] } | null>(`SELECT json_build_object('runIds',
    CASE WHEN d.enabled THEN COALESCE((SELECT json_agg(r.id) FROM agent_runs r
      WHERE r."deviceId"=d.id AND r.status=$3), '[]'::json) ELSE '[]'::json END)
    FROM devices d WHERE d.id=$1 AND d."ownerId"=$2 AND d."removedAt" IS NULL`, [deviceId, caller.userId, 'queued'])
  if (!result) return NextResponse.json({ error: 'Unknown device.' }, { status: 404 })
  return NextResponse.json(result)
}

export const GET = withDeviceRoute(handleGET)
