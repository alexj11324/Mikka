import { withDeviceRoute } from '@/lib/device-route'
import { NextResponse } from 'next/server'
import { readUnderDeviceAuthority } from '@/lib/db'
import { readRepositoryDaemonSettings } from '@/lib/device-repositories'
import { authenticateDevice } from '@/lib/device-link'

export const dynamic = 'force-dynamic'

/** Repository records and owner-scoped settings, never a local path allow-list. */
async function handleGET(request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { deviceId } = await params
  // Read the current owner and repository list under the same fresh credential
  // snapshot. Nonempty lists retain their existing owner-scoped settings reads.
  const rows = await readUnderDeviceAuthority<{ id: string; repoPath: string; remoteUrl: string | null }[] | null>(`SELECT COALESCE(
    (SELECT json_agg(json_build_object('id',r.id,'repoPath',r."repoPath",'remoteUrl',r."remoteUrl"))
      FROM device_repos r WHERE r."deviceId"=d.id), '[]'::json)
    FROM devices d WHERE d.id=$1 AND d."ownerId"=$2 AND d."removedAt" IS NULL`, [deviceId, caller.userId])
  if (!rows) return NextResponse.json({ error: 'Unknown device.' }, { status: 404 })
  const repos = await Promise.all(rows.map(async repo => {
    const settings = repo.remoteUrl ? await readRepositoryDaemonSettings(caller.userId, repo.remoteUrl) : null
    return {
      repoId: repo.id,
      name: repo.repoPath.split('/').filter(Boolean).pop() ?? repo.repoPath,
      path: repo.repoPath,
      remoteUrl: repo.remoteUrl,
      ...(settings?.setup ? { setup: settings.setup } : {}),
      ...(settings?.networkAllow ? { networkAllow: settings.networkAllow } : {}),
      // Push approval is pinned in claim.policy, not cached between runs.
    }
  }))
  return NextResponse.json({ repos })
}

export const GET = withDeviceRoute(handleGET)
