import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanup, cleanupTarget as target } from './cleanup-migration-snapshot.mjs'

// Every request is intercepted below. This suite performs no provider I/O.
globalThis.fetch = () => { throw new Error('unexpected_provider_io') }
const env = {
  GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_REF: 'refs/heads/acceptance/proactive-1157-1163',
  GITHUB_EVENT_NAME: 'push', GITHUB_ACTIONS: 'true', CI: 'true', VERCEL_TEAM_TOKEN: 'offline-fake-token',
}
const fixture = () => ({
  project: { id: target.projectId, accountId: target.teamId, name: target.projectName },
  active: { id: target.activeSessionId, projectId: target.projectId, sourceSandboxName: target.activeName, status: 'running', sourceSnapshotId: target.snapshotId, vcpus: 8, memory: 16384 },
  snapshot: { id: target.snapshotId, sourceSessionId: target.sourceSessionId },
  source: { id: target.sourceSessionId, projectId: target.projectId, sourceSandboxName: target.sourceName, status: 'stopped' },
})
function fake(data = fixture(), { lostDelete = false, deleteMissing = false } = {}) {
  const calls = []
  let deleted = !data.snapshot
  const fetchImpl = async (url, options) => {
    assert.equal(url.origin, target.api)
    assert.equal(url.search, '?teamId=' + target.teamId)
    assert.equal(options.headers.Authorization, 'Bearer ' + env.VERCEL_TEAM_TOKEN)
    assert.equal(options.redirect, 'error')
    assert.equal(options.body, undefined)
    calls.push({ method: options.method, path: url.pathname })
    if (options.method === 'DELETE') {
      assert.equal(url.pathname, '/v2/sandboxes/snapshots/' + target.snapshotId)
      if (lostDelete) throw new Error('simulated_response_loss')
      deleted = true
      return new Response(null, { status: deleteMissing ? 404 : 204 })
    }
    assert.equal(options.method, 'GET')
    if (url.pathname === '/v9/projects/' + target.projectId) return Response.json(data.project)
    if (url.pathname === '/v2/sandboxes/sessions/' + target.activeSessionId) return Response.json({ session: data.active })
    if (url.pathname === '/v2/sandboxes/sessions/' + target.sourceSessionId) return Response.json({ session: data.source })
    assert.equal(url.pathname, '/v2/sandboxes/snapshots/' + target.snapshotId)
    return deleted ? new Response(null, { status: 404 }) : Response.json({ snapshot: data.snapshot })
  }
  return { calls, fetchImpl }
}
const deletes = f => f.calls.filter(x => x.method === 'DELETE')

test('missing credential or wrong workflow scope makes zero requests', async () => {
  for (const patch of [{ VERCEL_TEAM_TOKEN: '' }, { GITHUB_REPOSITORY: 'wrong/repo' }, { GITHUB_EVENT_NAME: 'workflow_dispatch' }, { GITHUB_REF: 'refs/heads/main' }]) {
    const f = fake()
    assert.equal((await cleanup({ env: { ...env, ...patch }, fetchImpl: f.fetchImpl, report() {} })).exitCode, 1)
    assert.equal(f.calls.length, 0)
  }
})

test('wrong team, project, active session, or restore provenance prevents deletion', async () => {
  for (const edit of [d => { d.project.accountId = 'wrong' }, d => { d.project.id = 'wrong' }, d => { d.active.id = 'wrong' }, d => { d.active.projectId = 'wrong' }, d => { d.active.status = 'stopped' }, d => { d.active.sourceSnapshotId = 'wrong' }]) {
    const data = fixture(); edit(data)
    const f = fake(data)
    assert.equal((await cleanup({ env, fetchImpl: f.fetchImpl, report() {} })).exitCode, 1)
    assert.equal(deletes(f).length, 0)
  }
})

test('wrong snapshot or source session provenance prevents deletion', async () => {
  for (const edit of [d => { d.snapshot.id = 'wrong' }, d => { d.snapshot.sourceSessionId = 'wrong' }, d => { d.source.projectId = 'wrong' }, d => { d.source.status = 'running' }]) {
    const data = fixture(); edit(data)
    const f = fake(data)
    assert.equal((await cleanup({ env, fetchImpl: f.fetchImpl, report() {} })).exitCode, 1)
    assert.equal(deletes(f).length, 0)
  }
})

test('only the fixed snapshot is deleted once and verified absent; no secret is reported', async () => {
  const f = fake(), reports = []
  const result = await cleanup({ env, fetchImpl: f.fetchImpl, report: value => reports.push(value) })
  assert.equal(result.status, 'deleted')
  assert.equal(result.exitCode, 0)
  assert.deepEqual(deletes(f), [{ method: 'DELETE', path: '/v2/sandboxes/snapshots/' + target.snapshotId }])
  assert.equal(f.calls.at(-1).method, 'GET')
  assert.equal(JSON.stringify(reports).includes(env.VERCEL_TEAM_TOKEN), false)
})

test('404 is idempotent both before deletion and for an already-deleted DELETE', async () => {
  const data = fixture(); data.snapshot = null
  const missing = fake(data)
  assert.equal((await cleanup({ env, fetchImpl: missing.fetchImpl, report() {} })).status, 'already_deleted')
  assert.equal(deletes(missing).length, 0)
  const racing = fake(fixture(), { deleteMissing: true })
  assert.equal((await cleanup({ env, fetchImpl: racing.fetchImpl, report() {} })).status, 'deleted')
  assert.equal(deletes(racing).length, 1)
})

test('an unknown DELETE outcome is never retried', async () => {
  const f = fake(fixture(), { lostDelete: true })
  const result = await cleanup({ env, fetchImpl: f.fetchImpl, report() {} })
  assert.equal(result.status, 'cleanup_delete_unknown_no_retry')
  assert.equal(deletes(f).length, 1)
})
