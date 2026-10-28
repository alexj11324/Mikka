import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { readRepositorySettings } from '@/lib/device-repositories'
import { deviceRepos } from '@/lib/db/schema'
import { authenticateDevice, ownedDevice } from '@/lib/device-link'

export const dynamic = 'force-dynamic'

/** Repository records and owner-scoped settings, never a local path allow-list. */
export async function GET(request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { deviceId } = await params
  if (!await ownedDevice(deviceId, caller.userId)) return NextResponse.json({ error: 'Unknown device.' }, { status: 404 })
  const rows = await db.select().from(deviceRepos).where(eq(deviceRepos.deviceId, deviceId))
  const repos = await Promise.all(rows.map(async repo => {
    const settings = repo.remoteUrl ? await readRepositorySettings(caller.userId, repo.remoteUrl) : null
    return {
      repoId: repo.id,
      name: repo.repoPath.split('/').filter(Boolean).pop() ?? repo.repoPath,
      path: repo.repoPath,
      ...(settings?.setup ? { setup: settings.setup } : {}),
      ...(settings?.networkAllow ? { networkAllow: settings.networkAllow } : {}),
      // Push approval is pinned in claim.policy, not cached between runs.
    }
  }))
  return NextResponse.json({ repos })
}
