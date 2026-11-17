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

  async function makeShare(projectId?: string) {
    const location = projectId ? { workspaceId: workspace.id, projectId, driveScope: 'project' as const }
      : { workspaceId: workspace.id, driveScope: 'team-workspace' as const }
    const actor = { ownerId: projectId ? `drive-project:${workspace.id}:${projectId}` : 'drive-team:' + workspace.id, authorName: 'Drive creator' }
    const volume = await createDriveVolume(database, actor, { ...location, scopeId: projectId ?? workspace.id, name: 'Shared notes' },
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
  const team = await seedTeam(database, workspace.id, peer)
  const projectId = await seedProject(database, peer, [{ teamId: team.id, workspaceId: workspace.id }])
  const projectShare = await makeShare(projectId)
  const manageProjectShare = (method: 'PATCH' | 'DELETE') => run(method, mine, organizationId, 'org', origin, projectShare.id)
  assert.equal((await manageProjectShare('PATCH')).status, 200)
  await database.query("UPDATE resource_access_policies SET visibility='private' WHERE kind='project' AND id=$1", [projectId])
  assert.equal((await manageProjectShare('PATCH')).status, 404)
  await database.query("UPDATE resource_access_policies SET visibility='shared' WHERE kind='project' AND id=$1", [projectId])
  await database.query('UPDATE workspace_projects SET "archivedAt"=now() WHERE id=$1', [projectId])
  assert.equal((await manageProjectShare('DELETE')).status, 404)
  await database.query('UPDATE workspace_projects SET "archivedAt"=NULL WHERE id=$1', [projectId])
  assert.equal((await manageProjectShare('DELETE')).status, 204)
  const deleted = await run('DELETE', mine)
  assert.equal(deleted.status, 204)
  assert.equal(await deleted.text(), '')
  assert.equal((await run('DELETE', mine)).status, 404)
  assert.equal((await database.query('SELECT id FROM drive_file_links WHERE id=$1', [link.id])).rowCount, 0)
})
