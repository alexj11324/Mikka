import assert from 'node:assert/strict'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedProject, seedTeam, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'

test('organization share management holds the actual attachment, creator and current membership on every edit and deletion', { skip: !dbUrl }, async t => {
  const database = new Pool({ connectionString: dbUrl })
  const { pool } = await import('../db')
  const { workspacePool } = await import('../workspace-db')
  t.after(async () => { await Promise.all([database.end(), pool.end(), workspacePool.end()]) })
  const { auth } = await import('../auth')
  const application = await auth.$context
  const route = await import('../../app/api/organizations/[organizationId]/drive-shares/[shareId]/route')
  const { createDriveVolume } = await import('./volumes')
  const { recordDriveBlob, driveSha256 } = await import('./blobs')
  const { applyDriveWrite } = await import('./store')
  const { createDriveFileLink } = await import('./file-links')
  const { artifactStorage } = await import('../artifacts/storage')
  assert.equal(artifactStorage(), 'inline')
  const creator = await seedUser(database, 'drive-share-creator'), peer = await seedUser(database, 'drive-share-peer')
  const workspace = await seedWorkspace(database, creator, [{ userId: creator, role: 'admin' }, { userId: peer, role: 'member' }])
  const organizationId = randomUUID()
  await database.query('INSERT INTO mikka_organizations(id,name,"createdBy") VALUES ($1,$2,$3)', [organizationId, 'Drive', creator])
  const attach = () => database.query('INSERT INTO mikka_organization_workspaces("organizationId","workspaceId") VALUES ($1,$2)', [organizationId, workspace.id])
  await attach()
  for (const [person, role] of [[creator, 'member'], [peer, 'owner']]) {
    await database.query(`INSERT INTO mikka_organization_members("organizationId","userId",role,name,email)
      SELECT $1,id,$3,name,email FROM "user" WHERE id=$2`, [organizationId, person, role])
  }

  async function makeShare(projectId?: string, name = 'Shared notes') {
    const location = projectId ? { workspaceId: workspace.id, projectId, driveScope: 'project' as const }
      : { workspaceId: workspace.id, driveScope: 'team-workspace' as const }
    const actor = { ownerId: projectId ? `drive-project:${workspace.id}:${projectId}` : 'drive-team:' + workspace.id, authorName: 'Drive creator' }
    const volume = await createDriveVolume(database, actor, { ...location, scopeId: projectId ?? workspace.id, name },
      text => createHash('sha256').update(text).digest('hex'))
    const bytes = new TextEncoder().encode('selected bytes')
    const sha256 = driveSha256(bytes)
    await recordDriveBlob(database, { ownerId: actor.ownerId, sha256, sizeBytes: bytes.length, shared: { workspaceId: workspace.id, projectId } }, bytes)
    await applyDriveWrite(database, { ownerId: actor.ownerId, volumeId: volume.id, driveScope: location.driveScope }, actor, {
      expectedDigest: volume.headDigest, mutationId: randomUUID(), changes: [{ op: 'put', path: 'notes.txt', mode: 0o644, sha256, sizeBytes: bytes.length }],
    })
    return createDriveFileLink(database, volume.id, 'notes.txt', creator, location)
  }
  const link = await makeShare()

  async function cookie(person: string) {
    const session = await application.internalAdapter.createSession(person)
    assert.ok(session)
    const signature = createHmac('sha256', application.secret).update(session.token).digest('base64')
    return application.authCookies.sessionToken.name + '=' + encodeURIComponent(session.token + '.' + signature)
  }
  const mine = await cookie(creator), theirs = await cookie(peer)
  const origin = 'http://127.0.0.1:3000'
  const run = (method: 'PATCH' | 'DELETE', cookie: string, org: string = organizationId, visibility = 'private', requestOrigin = origin, shareId = link.id) => {
    const target = origin + '/api/organizations/' + org + '/drive-shares/' + shareId
    return route[method](new Request(target, { method, headers: { cookie, origin: requestOrigin, 'content-type': 'application/json' },
      body: method === 'PATCH' ? JSON.stringify({ visibility }) : undefined }), { params: Promise.resolve({ organizationId: org, shareId }) })
  }
  assert.equal((await run('PATCH', mine, organizationId, 'org', 'https://other.invalid')).status, 403)
  assert.equal((await run('PATCH', mine, organizationId, 'public')).status, 400)
  const updated = await run('PATCH', mine, organizationId, 'org')
  assert.equal(updated.status, 200)
  const item = await updated.json()
  assert.deepEqual([item.id, item.volumeId, item.path, item.visibility, item.manageable, item.createdBy], [link.id, link.volumeId, 'notes.txt', 'org', true, 'drive-share-creator'])
  assert.ok(Number.isFinite(Date.parse(item.createdAt)))
  assert.equal(new URL(item.url, origin).pathname, '/api/drive/volumes/' + link.volumeId + '/shares/' + link.id)
  assert.equal((await run('PATCH', theirs)).status, 404)
  assert.equal((await run('DELETE', theirs)).status, 404)
  assert.ok([403, 404].includes((await run('DELETE', mine, randomUUID())).status))
  await database.query(`UPDATE mikka_organization_members SET status='suspended' WHERE "organizationId"=$1 AND "userId"=$2`, [organizationId, creator])
  assert.ok([403, 404].includes((await run('DELETE', mine)).status))
  await database.query(`UPDATE mikka_organization_members SET status='active' WHERE "organizationId"=$1 AND "userId"=$2`, [organizationId, creator])
  await database.query('DELETE FROM mikka_organization_workspaces WHERE "organizationId"=$1 AND "workspaceId"=$2', [organizationId, workspace.id])
  assert.equal((await run('DELETE', mine)).status, 404)
  await attach()
  assert.equal((await run('PATCH', mine)).status, 200)
  const historyRoute = await import('../../app/api/organizations/[organizationId]/drive/[volumeId]/file-versions/route')
  function history(cookie: string, volumeId: string, path = 'notes.txt', org: string = organizationId) {
    const target = origin + '/api/organizations/' + org + '/drive/' + volumeId + '/file-versions?' + new URLSearchParams({ path })
    return historyRoute.GET(new Request(target, { headers: { cookie } }), { params: Promise.resolve({ organizationId: org, volumeId }) })
  }
  await t.test('organization file history selects stored content versions by complete path, excludes deletions and rechecks the volume tenant', async () => {
    const { volumeId } = await makeShare(undefined, 'Path history')
    const actor = { ownerId: 'drive-team:' + workspace.id, authorName: 'Next author', threadTitle: 'Selected task' }
    const bytes = new TextEncoder().encode('changed bytes')
    const sha256 = driveSha256(bytes)
    await recordDriveBlob(database, { ownerId: actor.ownerId, sha256, sizeBytes: bytes.length, shared: { workspaceId: workspace.id } }, bytes)
    const initial = (await database.query('SELECT "headVersionId","headDigest" FROM drive_volumes WHERE id=$1', [volumeId])).rows[0]
    const scope = { ownerId: actor.ownerId, volumeId, driveScope: 'team-workspace' as const }
    const put = (path: string) => ({ op: 'put' as const, path, mode: 0o644 as const, sha256, sizeBytes: bytes.length })
    const unrelated = await applyDriveWrite(database, scope, actor, { expectedDigest: initial.headDigest, mutationId: randomUUID(), changes: [put('other/notes.txt')] })
    const changed = await applyDriveWrite(database, scope, actor, { expectedDigest: unrelated.headDigest, mutationId: randomUUID(), changes: [put('notes.txt')] })
    await applyDriveWrite(database, scope, actor, { expectedDigest: changed.headDigest, mutationId: randomUUID(), changes: [{ op: 'delete', path: 'notes.txt' }] })
    const response = await history(theirs, volumeId)
    assert.equal(response.status, 200)
    const rows = await response.json()
    assert.deepEqual(rows.map((v: { versionId: string }) => v.versionId), [changed.headVersionId, initial.headVersionId])
    assert.deepEqual(Object.keys(rows[0]).sort(), ['authorName', 'createdAt', 'sha256', 'sizeBytes', 'threadTitle', 'versionId'])
    assert.equal(rows[0].sha256, sha256)
    assert.equal(rows[0].sizeBytes, bytes.length)
    assert.equal(rows[0].authorName, actor.authorName)
    assert.equal(rows[0].threadTitle, actor.threadTitle)
    assert.ok(Number.isFinite(Date.parse(rows[0].createdAt)))
    assert.deepEqual((await (await history(mine, volumeId, 'other/notes.txt')).json()).map((v: { versionId: string }) => v.versionId), [unrelated.headVersionId])
    assert.deepEqual(await (await history(mine, volumeId, 'absent.txt')).json(), [])
    assert.ok([403, 404].includes((await history(mine, volumeId, 'notes.txt', randomUUID())).status))
    await database.query(`UPDATE mikka_organization_members SET status='suspended' WHERE "organizationId"=$1 AND "userId"=$2`, [organizationId, peer])
    assert.ok([403, 404].includes((await history(theirs, volumeId)).status))
    await database.query(`UPDATE mikka_organization_members SET status='active' WHERE "organizationId"=$1 AND "userId"=$2`, [organizationId, peer])
  })
  await t.test('organization manifests identify their actual predecessor and complete history retains restored versions beyond the Workspace page', async () => {
    const manifestRoute = await import('../../app/api/organizations/[organizationId]/drive/[volumeId]/versions/[versionId]/route')
    const listRoute = await import('../../app/api/organizations/[organizationId]/drive/[volumeId]/versions/route')
    const { restoreDriveVersion } = await import('./store')
    const team = await seedTeam(database, workspace.id, peer)
    const projectId = await seedProject(database, peer, [{ teamId: team.id, workspaceId: workspace.id }])
    const { volumeId } = await makeShare(projectId, 'Immutable versions')
    const { rows: [first, second] } = await database.query<{id: string; digest: string}>(
      'SELECT id,digest FROM drive_volume_versions WHERE "volumeId"=$1 ORDER BY seq', [volumeId])
    const addr = origin + '/api/organizations/' + organizationId + '/drive/' + volumeId + '/versions'
    const getManifest = (versionId: string, cookie = mine) => manifestRoute.GET(new Request(addr + '/' + versionId, { headers: { cookie } }),
      { params: Promise.resolve({ organizationId, volumeId, versionId }) })
    const getVersions = (cookie = mine) => listRoute.GET(new Request(addr, { headers: { cookie } }), { params: Promise.resolve({ organizationId, volumeId }) })
    assert.equal((await (await getManifest(first.id)).json()).parentDigest, null)
    const manifest = await (await getManifest(second.id)).json()
    assert.deepEqual(Object.keys(manifest).sort(), ['digest', 'entries', 'fileCount', 'parentDigest', 'totalBytes', 'versionId', 'volumeId'])
    assert.deepEqual([manifest.parentDigest, manifest.digest, manifest.entries[0].path], [first.digest, second.digest, 'notes.txt'])
    const actor = { ownerId: `drive-project:${workspace.id}:${projectId}`, authorName: 'Drive creator' }
    let latest = second
    for (let n = 0; n < 50; n++) {
      const restored = await restoreDriveVersion(database, { ownerId: actor.ownerId, volumeId }, actor, {
        expectedDigest: latest.digest, versionId: n % 2 ? second.id : first.id, mutationId: randomUUID(),
      })
      latest = { id: restored.headVersionId, digest: restored.headDigest }
    }
    const rows = await (await getVersions()).json()
    assert.equal(rows.length, 52)
    assert.deepEqual([rows[0].id, rows[0].kind, rows[0].volumeId, rows[0].authorName], [latest.id, 'restore', volumeId, actor.authorName])
    assert.equal(rows.at(-1).id, first.id)
    assert.deepEqual(Object.keys(rows[0]).sort(), ['authorName', 'createdAt', 'fileCount', 'id', 'kind', 'threadId', 'threadTitle', 'totalBytes', 'volumeId'])
    assert.equal((await (await getManifest(latest.id)).json()).parentDigest, first.digest)
    await database.query("UPDATE resource_access_policies SET visibility='private' WHERE kind='project' AND id=$1", [projectId])
    assert.equal((await getManifest(first.id)).status, 404)
    assert.equal((await getVersions()).status, 404)
    assert.equal((await getManifest(first.id, theirs)).status, 200)
  })
  const team = await seedTeam(database, workspace.id, peer)
  const projectId = await seedProject(database, peer, [{ teamId: team.id, workspaceId: workspace.id }])
  const projectShare = await makeShare(projectId)
  const manageProjectShare = (method: 'PATCH' | 'DELETE') => run(method, mine, organizationId, 'org', origin, projectShare.id)
  assert.equal((await manageProjectShare('PATCH')).status, 200)
  await database.query("UPDATE resource_access_policies SET visibility='private' WHERE kind='project' AND id=$1", [projectId])
  assert.equal((await manageProjectShare('PATCH')).status, 404)
  assert.equal((await history(mine, projectShare.volumeId)).status, 404)
  await database.query("UPDATE resource_access_policies SET visibility='shared' WHERE kind='project' AND id=$1", [projectId])
  await database.query('UPDATE workspace_projects SET "archivedAt"=now() WHERE id=$1', [projectId])
  assert.equal((await manageProjectShare('DELETE')).status, 404)
  assert.equal((await history(mine, projectShare.volumeId)).status, 404)
  await database.query('UPDATE workspace_projects SET "archivedAt"=NULL WHERE id=$1', [projectId])
  assert.equal((await manageProjectShare('DELETE')).status, 204)
  await t.test('organization skill metadata uses each admitted current volume and fully pages a selected Project without disclosing instructions', async () => {
    const skills = await import('../../app/api/organizations/[organizationId]/drive-skills/route')
    const volume = await makeShare(projectId, 'Skills')
    const namespace = 'drive-project:' + workspace.id + ':' + projectId
    const actor = { ownerId: namespace, authorName: 'Skill author' }
    const bytes = new TextEncoder().encode('---\nname: example\ndescription: Visible summary\n---\nPrivate instructions')
    const sha256 = driveSha256(bytes)
    await recordDriveBlob(database, { ownerId: namespace, sha256, sizeBytes: bytes.length, shared: { workspaceId: workspace.id, projectId } }, bytes)
    const head = (await database.query('SELECT "headDigest" FROM drive_volumes WHERE id=$1', [volume.volumeId])).rows[0].headDigest
    const names = Array.from({ length: 27 }, (_, i) => 'skill-' + String(i).padStart(2, '0'))
    const scope = { ownerId: namespace, volumeId: volume.volumeId, driveScope: 'project' as const }
    const written = await applyDriveWrite(database, scope, actor, {
      expectedDigest: head, mutationId: randomUUID(), changes: names.map(name => ({
        op: 'put' as const, path: 'skills/' + name + '/SKILL.md', mode: 0o644 as const, sha256, sizeBytes: bytes.length,
      })),
    })
    const read = (cookie: string, query = '') => skills.GET(new Request(origin + '/api/organizations/' + organizationId + '/drive-skills?' + query,
      { headers: { cookie } }), { params: Promise.resolve({ organizationId }) })
    const filter = 'projectId=' + projectId
    const response = await read(mine, filter)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), names.map(name => ({ name, description: 'Visible summary' })))
    assert.equal((await read(theirs, filter + '&' + filter)).status, 400)
    assert.equal((await read(theirs, 'threadId=' + randomUUID())).status, 400)
    assert.deepEqual(await (await read(mine, 'projectId=' + randomUUID())).json(), [])
    await applyDriveWrite(database, scope, actor, { expectedDigest: written.headDigest, mutationId: randomUUID(),
      changes: [{ op: 'delete', path: 'skills/' + names[0] + '/SKILL.md' }] })
    assert.deepEqual(await (await read(theirs, filter)).json(), names.slice(1).map(name => ({ name, description: 'Visible summary' })))
    await database.query("UPDATE resource_access_policies SET visibility='private' WHERE kind='project' AND id=$1", [projectId])
    assert.deepEqual(await (await read(mine, filter)).json(), [])
    assert.deepEqual(await (await read(mine)).json(), [])
    assert.equal((await (await read(theirs, filter)).json()).length, 26)
    await database.query('UPDATE drive_volumes SET "archivedAt"=now() WHERE id=$1', [volume.volumeId])
    assert.deepEqual(await (await read(theirs, filter)).json(), [])
    await database.query("UPDATE resource_access_policies SET visibility='shared' WHERE kind='project' AND id=$1", [projectId])
  })
  const deleted = await run('DELETE', mine)
  assert.equal(deleted.status, 204)
  assert.equal(await deleted.text(), '')
  assert.equal((await run('DELETE', mine)).status, 404)
  assert.equal((await database.query('SELECT id FROM drive_file_links WHERE id=$1', [link.id])).rowCount, 0)
})
