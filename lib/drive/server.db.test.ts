import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { mock, test } from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedPersonalWorkspace, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'

test('private Drive HTTP lifecycle uses real PAT, tenant admission, CAS and versioned bytes', { skip: !dbUrl, timeout: 60_000 }, async t => {
  // Browser authentication is absent; every successful HTTP request must verify
  // its actual stored PAT and its current Workspace membership.
  const browser = mock.module('@/lib/auth', { namedExports: { MOBILE_APP_ORIGIN: 'mikka://', auth: { api: { getSession: async () => null } } } })
  t.after(() => browser.restore())
  const fixture = new Pool({ connectionString: dbUrl })
  await fixture.query(await readFile(new URL('../../drizzle/20261112030506_drive_blob_workspace_admission.sql', import.meta.url), 'utf8'))
  const { pool } = await import('../db')
  const { workspacePool } = await import('../workspace-db')
  const tokens = await import('../tokens/store')
  const { artifactStorage } = await import('../artifacts/storage')
  assert.equal(artifactStorage(), 'inline', 'this test must not use any external object storage')
  const collection = await import('../../app/api/drive/volumes/route')
  const detail = await import('../../app/api/drive/volumes/[volumeId]/route')
  const upload = await import('../../app/api/drive/volumes/[volumeId]/blobs/route')
  const entries = await import('../../app/api/drive/volumes/[volumeId]/entries/route')
  const file = await import('../../app/api/drive/volumes/[volumeId]/files/route')
  const history = await import('../../app/api/drive/volumes/[volumeId]/versions/route')
  const version = await import('../../app/api/drive/volumes/[volumeId]/versions/[versionId]/route')
  const restore = await import('../../app/api/drive/volumes/[volumeId]/restore/route')
  const handlers = { blobs: upload.POST, entries: entries.PATCH, files: file.GET, versions: history.GET, restore: restore.POST }
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const request = new Request(`http://${incoming.headers.host}${incoming.url}`, { method: incoming.method,
        headers: incoming.headers as Record<string, string>, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) })
      const segments = new URL(request.url).pathname.split('/').filter(Boolean).slice(3)
      const params = Promise.resolve({ volumeId: segments[0], versionId: segments[2] })
      const response = !segments.length
        ? await (request.method === 'POST' ? collection.POST : collection.GET)(request)
        : segments.length === 1 ? await detail.GET(request, { params })
          : segments.length === 3 ? await version.GET(request, { params })
            : await handlers[segments[1] as keyof typeof handlers](request, { params })
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      outgoing.end(Buffer.from(await response.arrayBuffer()))
    } catch (error) { outgoing.writeHead(500); outgoing.end(); throw error }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await Promise.all([fixture.end(), pool.end(), workspacePool.end()])
  })
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const owner = await seedUser(fixture, 'drive-http-owner'), peer = await seedUser(fixture, 'drive-http-peer')
  const personal = await seedPersonalWorkspace(fixture, owner)
  const team = await seedWorkspace(fixture, owner, [{ userId: owner, role: 'admin' }, { userId: peer, role: 'member' }])
  const ownerToken = (await tokens.createLegacyPersonalAccessToken(owner, personal, { name: 'Drive HTTP personal' })).token
  const sharedToken = (await tokens.createLegacyPersonalAccessToken(owner, team.id, { name: 'Drive HTTP other tenant' })).token
  const peerToken = (await tokens.createLegacyPersonalAccessToken(peer, team.id, { name: 'Drive HTTP peer' })).token
  const call = (suffix = '', options: { token?: string | null; workspaceId?: string; method?: string; body?: unknown; raw?: string; origin?: string } = {}) => {
    const url = new URL(`/api/drive/volumes${suffix}`, origin)
    url.searchParams.set('workspaceId', options.workspaceId ?? personal)
    const bearer = options.token === undefined ? ownerToken : options.token
    return fetch(url, { method: options.method ?? 'GET', headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(options.method ? { origin: options.origin ?? origin } : {}), ...(options.body ? { 'content-type': 'application/json' } : {}) },
      body: options.raw ?? (options.body ? JSON.stringify(options.body) : undefined) })
  }
  const created = await call('', { method: 'POST', body: { name: `Drive ${randomUUID()}` } })
  assert.equal(created.status, 201)
  const volume = (await created.json()).volume
  const duplicate = await call('', { method: 'POST', body: { name: volume.name } })
  assert.equal(duplicate.status, 409)
  assert.deepEqual(await duplicate.json(), { error: 'drive_volume_exists' })
  assert.equal(created.headers.get('cache-control'), 'private, no-store')
  assert.equal((await call('', { token: null })).status, 401)
  assert.equal((await call('', { method: 'POST', body: { name: 'Cross origin' }, origin: 'https://other.invalid' })).status, 403)
  const listed = await (await call()).json()
  assert.deepEqual(listed.volumes.map((row: { id: string }) => row.id), [volume.id])
  const fresh = await (await call(`/${volume.id}`)).json()
  assert.deepEqual(fresh.head.entries, [])
  const blobA = await (await call(`/${volume.id}/blobs`, { method: 'POST', raw: 'first file bytes' })).json()
  assert.equal(blobA.sha256, createHash('sha256').update('first file bytes').digest('hex'))
  const writeA = { expectedDigest: fresh.head.headDigest, mutationId: randomUUID(), changes: [{ op: 'put', path: 'notes/result.txt', mode: 0o644, ...blobA }] }
  const written = await call(`/${volume.id}/entries`, { method: 'PATCH', body: writeA })
  assert.equal(written.status, 200)
  const first = await written.json()
  assert.equal((await (await call(`/${volume.id}/entries`, { method: 'PATCH', body: writeA })).json()).replayed, true)
  const conflict = await call(`/${volume.id}/entries`, { method: 'PATCH', body: { ...writeA, mutationId: randomUUID() } })
  assert.equal(conflict.status, 409)
  assert.equal((await conflict.json()).headDigest, first.headDigest)
  const download = await fetch(`${origin}/api/drive/volumes/${volume.id}/files?workspaceId=${personal}&path=notes%2Fresult.txt`, { headers: { authorization: `Bearer ${ownerToken}` } })
  assert.equal(download.status, 200)
  assert.equal(await download.text(), 'first file bytes')
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff')
  assert.match(download.headers.get('content-disposition')!, /^attachment;/)
  const blobB = await (await call(`/${volume.id}/blobs`, { method: 'POST', raw: 'next file bytes' })).json()
  const second = await (await call(`/${volume.id}/entries`, { method: 'PATCH', body: { expectedDigest: first.headDigest, mutationId: randomUUID(), changes: [{ op: 'put', path: 'notes/result.txt', mode: 0o644, ...blobB }] } })).json()
  const restored = await call(`/${volume.id}/restore`, { method: 'POST', body: { versionId: first.headVersionId, expectedDigest: second.headDigest, mutationId: randomUUID() } })
  assert.equal(restored.status, 200)
  const restoredBody = await restored.json()
  assert.equal(restoredBody.seq, 4)
  const versions = await (await call(`/${volume.id}/versions`)).json()
  assert.deepEqual(versions.versions.map((row: { seq: number }) => row.seq), [4, 3, 2, 1])
  const historical = await (await call(`/${volume.id}/versions/${second.headVersionId}`)).json()
  assert.equal(historical.version.manifest[0].sha256, blobB.sha256)
  const current = await (await call(`/${volume.id}`)).json()
  assert.equal(current.head.headDigest, restoredBody.headDigest)
  assert.equal(current.head.entries[0].sha256, blobA.sha256)
  assert.equal(await (await call(`/${volume.id}/files?path=notes%2Fresult.txt`)).text(), 'first file bytes')
  assert.equal(await (await call(`/${volume.id}/files?path=notes%2Fresult.txt&versionId=${second.headVersionId}`)).text(), 'next file bytes')
  const mismatch = await call(`/${volume.id}/entries`, { method: 'PATCH', body: { ...writeA, changes: [{ ...writeA.changes[0], path: 'another.txt' }] } })
  assert.equal(mismatch.status, 409)
  assert.equal((await mismatch.json()).error, 'drive_replay_mismatch')
  for (const path of ['../escape', '/absolute', 'bad\\path', 'a//b']) {
    const invalid = await call(`/${volume.id}/entries`, { method: 'PATCH', body: { expectedDigest: restoredBody.headDigest, mutationId: randomUUID(), changes: [{ ...writeA.changes[0], path }] } })
    assert.equal(invalid.status, 400)
  }
  assert.equal((await call('', { method: 'POST', body: { name: 'No identity overrides', ownerId: peer } })).status, 400)
  const pagedHistory = await (await call(`/${volume.id}/versions?limit=1`)).json()
  assert.equal(pagedHistory.versions.length, 1)
  assert.equal(pagedHistory.versions[0].seq, 4)
  const nextHistory = await (await call(`/${volume.id}/versions?limit=1&before=${pagedHistory.nextCursor}`)).json()
  assert.equal(nextHistory.versions[0].seq, 3)
  assert.equal((await (await call(`/${volume.id}/versions`)).json()).versions.length, 4, 'invalid and replayed writes add no versions')
  for (const suffix of [`/${volume.id}`, `/${volume.id}/versions`, `/${volume.id}/versions/${first.headVersionId}`]) {
    assert.equal((await call(suffix, { token: sharedToken, workspaceId: team.id })).status, 404)
    assert.equal((await call(suffix, { token: peerToken, workspaceId: team.id })).status, 404)
  }
  assert.equal((await call(`/${volume.id}`, { workspaceId: team.id })).status, 404, 'a PAT cannot select another tenant of its owner')
  const sameNameInTeam = await call('', { token: sharedToken, workspaceId: team.id, method: 'POST', body: { name: volume.name } })
  assert.equal(sameNameInTeam.status, 201, 'one owner can reuse a private folder name in another workspace')
  const teamFolder = (await sameNameInTeam.json()).volume
  assert.notEqual(teamFolder.id, volume.id)
  assert.equal((await call(`/${teamFolder.id}`)).status, 404)
  const duplicateInTeam = await call('', { token: sharedToken, workspaceId: team.id, method: 'POST', body: { name: volume.name } })
  assert.equal(duplicateInTeam.status, 409)
  assert.deepEqual(await duplicateInTeam.json(), { error: 'drive_volume_exists' })
  const sharedCreate = await call('', { token: sharedToken, workspaceId: team.id, method: 'POST', body: { name: `Other tenant ${randomUUID()}` } })
  const otherVolume = (await sharedCreate.json()).volume
  assert.equal((await call(`/${otherVolume.id}/versions/${first.headVersionId}`, { token: sharedToken, workspaceId: team.id })).status, 404)
  const crossTenantBlob = await call(`/${otherVolume.id}/entries`, { token: sharedToken, workspaceId: team.id, method: 'PATCH', body: {
    expectedDigest: otherVolume.headDigest, mutationId: randomUUID(), changes: [{ op: 'put', path: 'personal-copy.txt', mode: 0o644, ...blobA }],
  } })
  assert.equal(crossTenantBlob.status, 422, 'a tenant-scoped PAT cannot name a blob uploaded only in another tenant of the same owner')
  assert.equal((await crossTenantBlob.json()).error, 'drive_blob_unknown')
  const admittedAgain = await (await call(`/${otherVolume.id}/blobs`, { token: sharedToken, workspaceId: team.id, method: 'POST', raw: 'first file bytes' })).json()
  assert.equal(admittedAgain.sha256, blobA.sha256, 'physical owner deduplication still reuses the same bytes')
  const sameTenantCopy = await call(`/${otherVolume.id}/entries`, { token: sharedToken, workspaceId: team.id, method: 'PATCH', body: {
    expectedDigest: otherVolume.headDigest, mutationId: randomUUID(), changes: [{ op: 'put', path: 'uploaded-here.txt', mode: 0o644, ...admittedAgain }],
  } })
  assert.equal(sameTenantCopy.status, 200, 'uploading the actual bytes grants this Workspace its own admission')
  const admittedHead = await sameTenantCopy.json()
  assert.equal((await fixture.query('SELECT count(*)::int AS n FROM drive_blobs WHERE "ownerId"=$1 AND sha256=$2', [owner, blobA.sha256])).rows[0].n, 1)
  const peerCreate = await call('', { token: peerToken, workspaceId: team.id, method: 'POST', body: { name: `Peer ${randomUUID()}` } })
  const peerVolume = (await peerCreate.json()).volume
  const peerBlob = await (await call(`/${peerVolume.id}/blobs`, { token: peerToken, workspaceId: team.id, method: 'POST', raw: 'private peer bytes' })).json()
  const graft = await call(`/${otherVolume.id}/entries`, { token: sharedToken, workspaceId: team.id, method: 'PATCH', body: { expectedDigest: admittedHead.headDigest, mutationId: randomUUID(), changes: [{ op: 'put', path: 'stolen.txt', mode: 0o644, ...peerBlob }] } })
  assert.equal(graft.status, 422)
  assert.equal((await graft.json()).error, 'drive_blob_unknown')
  await call('', { method: 'POST', body: { name: `Next page ${randomUUID()}` } })
  const firstPage = await (await call('?limit=1')).json()
  assert.equal(firstPage.volumes.length, 1)
  assert.ok(firstPage.nextCursor)
  const nextPage = await (await call(`?limit=1&before=${firstPage.nextCursor}`)).json()
  assert.equal(nextPage.volumes[0].id, volume.id)
  assert.equal(nextPage.nextCursor, null)
  await fixture.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [team.id, owner])
  assert.equal((await call(`/${otherVolume.id}`, { token: sharedToken, workspaceId: team.id })).status, 401)
  await fixture.query(`UPDATE personal_access_tokens SET "revokedAt"=now() WHERE "userId"=$1`, [owner])
  assert.equal((await call(`/${volume.id}`)).status, 401)
  const workspaceDeletion = await (await import('../workspace-rows')).workspaceDeletionStatements(fixture, team.id)
  const workspaceAdmissionDelete = workspaceDeletion.find(statement => statement.table === 'drive_blob_admissions')
  assert.ok(workspaceAdmissionDelete, 'Workspace cleanup discovers the new admission table by its tenant column')
  await fixture.query(workspaceAdmissionDelete.text, workspaceAdmissionDelete.values)
  assert.equal((await fixture.query('SELECT count(*)::int AS n FROM drive_blob_admissions WHERE "workspaceId"=$1', [team.id])).rows[0].n, 0)
  assert.ok((await fixture.query('SELECT 1 FROM drive_blob_admissions WHERE "workspaceId"=$1', [personal])).rowCount)
  const accountDeletion = await (await import('../account/delete')).deletionStatements(fixture, owner,
    { solo: [personal], shared: [team.id], keptIssueIds: [], keptProjectIds: [] },
    { bots: [], runs: [], agents: [], artifacts: [], factoryTasks: [], events: [], mailboxes: [] })
  const accountAdmissionDelete = accountDeletion.find(statement => statement.table === 'drive_blob_admissions')
  assert.ok(accountAdmissionDelete, 'Account cleanup discovers the new admission table by its owner column')
  await fixture.query(accountAdmissionDelete.text, accountAdmissionDelete.values)
  assert.equal((await fixture.query('SELECT count(*)::int AS n FROM drive_blob_admissions WHERE "ownerId"=$1', [owner])).rows[0].n, 0)
})
