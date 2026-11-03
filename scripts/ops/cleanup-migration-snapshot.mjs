// TEMPORARY acceptance-branch cleanup; no model or sandbox command invocation.
// Official API: https://vercel.com/docs/rest-api/sandboxes/delete-a-snapshot
// DELETE /v2/sandboxes/snapshots/{snapshotId}?teamId={teamId}
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export const cleanupTarget = Object.freeze({
  api: 'https://api.vercel.com',
  teamId: 'team_C7lwxVVvnUicFli6112mvxpv',
  projectId: 'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH',
  projectName: 'mikka',
  snapshotId: 'snap_w2j6IpCIer1t5qFlw8IiKgY6eQvp',
  sourceSessionId: 'sbx_T04DxqVEqf2rMbl7r7SBt9MmUJNg',
  sourceName: 'mikka-proactive-1157-1163-20261103',
  activeSessionId: 'sbx_i0JVU4ryiQnowZ6IWX9zrkOdWbHR',
  activeName: 'mikka-proactive-1157-1163-16g-20261103',
})
class CleanupError extends Error {}
const fail = code => { throw new CleanupError(code) }

export async function cleanup({ env = process.env, fetchImpl = fetch, report = value => console.log(JSON.stringify(value)) } = {}) {
  let deletionAttempted = false
  try {
    if (env.GITHUB_REPOSITORY !== 'alexj11324/Mikka'
      || env.GITHUB_REF !== 'refs/heads/acceptance/proactive-1157-1163'
      || env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_ACTIONS !== 'true' || env.CI !== 'true') fail('cleanup_runner_boundary_rejected')
    const token = env.VERCEL_TEAM_TOKEN
    if (typeof token !== 'string' || !token.trim() || /[\r\n\0]/.test(token)) fail('cleanup_credential_missing')
    const request = async (path, method = 'GET', allowMissing = false) => {
      const url = new URL(path, cleanupTarget.api)
      url.searchParams.set('teamId', cleanupTarget.teamId)
      let response
      try {
        response = await fetchImpl(url, {
          method, headers: { Authorization: 'Bearer ' + token },
          redirect: 'error', signal: AbortSignal.timeout(15_000),
        })
      } catch { fail(method === 'DELETE' ? 'cleanup_delete_unknown_no_retry' : 'cleanup_provider_request_failed') }
      if (response.status === 404 && allowMissing) return null
      if (!response.ok) fail('cleanup_provider_request_rejected')
      // DELETE can return 204. Its body is never logged or needed.
      if (method === 'DELETE') return true
      try { return await response.json() } catch { fail('cleanup_provider_response_invalid') }
    }
    const project = await request('/v9/projects/' + cleanupTarget.projectId)
    if (project.id !== cleanupTarget.projectId || project.accountId !== cleanupTarget.teamId || project.name !== cleanupTarget.projectName) fail('cleanup_project_boundary_rejected')
    const { session: active } = await request('/v2/sandboxes/sessions/' + cleanupTarget.activeSessionId)
    if (active?.id !== cleanupTarget.activeSessionId || active.projectId !== cleanupTarget.projectId
      || active.sourceSandboxName !== cleanupTarget.activeName || active.status !== 'running'
      || active.sourceSnapshotId !== cleanupTarget.snapshotId || active.vcpus !== 8 || active.memory !== 16384) fail('cleanup_active_session_boundary_rejected')
    const snapshotPath = '/v2/sandboxes/snapshots/' + cleanupTarget.snapshotId
    const existing = await request(snapshotPath, 'GET', true)
    if (existing === null) {
      const result = { status: 'already_deleted', snapshotId: cleanupTarget.snapshotId, activeSessionId: cleanupTarget.activeSessionId, exitCode: 0 }
      report(result)
      return result
    }
    if (existing.snapshot?.id !== cleanupTarget.snapshotId || existing.snapshot.sourceSessionId !== cleanupTarget.sourceSessionId) fail('cleanup_snapshot_boundary_rejected')
    const { session: source } = await request('/v2/sandboxes/sessions/' + cleanupTarget.sourceSessionId)
    if (source?.id !== cleanupTarget.sourceSessionId || source.projectId !== cleanupTarget.projectId
      || source.sourceSandboxName !== cleanupTarget.sourceName || source.status !== 'stopped') fail('cleanup_source_boundary_rejected')
    deletionAttempted = true
    await request(snapshotPath, 'DELETE', true)
    // This is a read-only confirmation. There is deliberately no DELETE retry.
    if (await request(snapshotPath, 'GET', true) !== null) fail('cleanup_delete_not_confirmed')
    const result = { status: 'deleted', snapshotId: cleanupTarget.snapshotId, activeSessionId: cleanupTarget.activeSessionId, exitCode: 0 }
    report(result)
    return result
  } catch (error) {
    const result = { status: error instanceof CleanupError ? error.message : 'cleanup_failed', snapshotId: cleanupTarget.snapshotId, deletionAttempted, exitCode: 1 }
    report(result)
    return result
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = (await cleanup()).exitCode
