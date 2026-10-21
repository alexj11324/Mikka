import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { deviceRepos } from '@/lib/db/schema'
import { authenticateDevice, ownedDevice } from '@/lib/device-link'

export const dynamic = 'force-dynamic'

/** `GET /v1/devices/:deviceId/repos`: the repos this device's agents may work in. */
export async function GET(request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { deviceId } = await params
  if (!await ownedDevice(deviceId, caller.userId)) return NextResponse.json({ error: 'Unknown device.' }, { status: 404 })
  const rows = await db.select().from(deviceRepos).where(eq(deviceRepos.deviceId, deviceId))
  return NextResponse.json({
    repos: rows.map(repo => ({
      repoId: repo.id,
      name: repo.repoPath.split('/').filter(Boolean).pop() ?? repo.repoPath,
      path: repo.repoPath,
    })),
  })
}
