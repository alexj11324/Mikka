import { withDeviceRoute } from '@/lib/device-route'
import { NextResponse } from '@/lib/server-runtime/server'
import { daemonTestMode, normalizeRepository } from '@mikka/protocol/repository'
import { readUnderDeviceAuthority } from '@/lib/db'
import { readRepositoryDaemonSettings } from '@/lib/device-repositories'
import { authenticateDevice } from '@/lib/device-link'


/** Repository records and owner-scoped settings, never a local path allow-list. */
async function handleGET(request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { deviceId } = await params
  // Read the current owner and repository list under the same fresh credential
  // snapshot. Nonempty lists retain their existing owner-scoped settings reads.
  const directory = await readUnderDeviceAuthority<{ kind: string; repos: { id: string; repoPath: string; remoteUrl: string | null }[] } | null>(`SELECT json_build_object('kind',d.kind,'repos',COALESCE(
    (SELECT json_agg(json_build_object('id',r.id,'repoPath',r."repoPath",'remoteUrl',r."remoteUrl"))
      FROM device_repos r WHERE r."deviceId"=d.id AND r."userId"=d."ownerId"), '[]'::json))
    FROM devices d WHERE d.id=$1 AND d."ownerId"=$2 AND d."removedAt" IS NULL`, [deviceId, caller.userId])
  if (!directory) return NextResponse.json({ error: 'Unknown device.' }, { status: 404 })
  const records = directory.repos.flatMap(repo => {
    // Hosted workers use their provisioned directory. On personal devices the
    // released daemon uses the remote and its own cache, including for old rows.
    if (directory.kind === 'cloud' || repo.repoPath.startsWith('v2/')) return [repo]
    if (!repo.remoteUrl) return []
    try {
      const repository = normalizeRepository(repo.remoteUrl, { allowFile: daemonTestMode(process.env) })
      return [{ ...repo, repoPath: repository.key }]
    } catch { return [] }
  })
  const repos = await Promise.all(records.map(async repo => {
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
