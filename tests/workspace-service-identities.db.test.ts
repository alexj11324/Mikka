import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { serve } from 'srvx/node'
import { createApiHandler } from '../apps/api/src/application'
import { routes } from '../apps/api/generated/routes'
import { dbUrl, seedProject, seedTeam, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('registered service identity routes enforce a fresh Workspace admin through real TCP and PostgreSQL', { skip: !dbUrl }, async t => {
  const [{ pool }, { workspacePool }, tokens] = await Promise.all([
    import('../lib/db'), import('../lib/workspace-db'), import('../lib/tokens/store'),
  ])
  const owner = await seedUser(pool, 'identity-owner'), member = await seedUser(pool, 'identity-member')
  const tenants: string[] = []
  t.after(async () => {
    try {
      await pool.query('DELETE FROM workspace_projects WHERE "workspaceId"=ANY($1::uuid[])', [tenants])
      await pool.query('DELETE FROM resource_access_policies WHERE kind=\'project\' AND "workspaceId"=ANY($1::uuid[])', [tenants])
      await pool.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [tenants])
      await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [[owner, member]])
    } finally { await Promise.all([pool.end(), workspacePool.end()]) }
  })
  const first = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: member, role: 'member' }])
  tenants.push(first.id)
  const second = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  tenants.push(second.id)
  const admin = await tokens.createLegacyPersonalAccessToken(owner, first.id, { name: 'Service identity HTTP fixture' })
  const other = await tokens.createLegacyPersonalAccessToken(owner, second.id, { name: 'Other Workspace fixture' })
  const ordinary = await tokens.createLegacyPersonalAccessToken(member, first.id, { name: 'Member fixture' })

  const app = createApiHandler(routes)
  const runtime = serve({ manual: true, silent: true, gracefulShutdown: false, fetch: request => app.fetch(request) })
  const listener = createServer(runtime.node!.handler)
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  t.after(async () => {
    listener.closeAllConnections()
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
    await runtime.close()
  })
  const address = listener.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const request = async (credentials: string | Record<string, string>, workspaceId: string, method: string, suffix = '', body?: unknown) => {
    const response = await fetch(`${origin}/mikka/api/workspaces/${workspaceId}/service-identities${suffix}`, {
      method, headers: { ...(typeof credentials === 'string' ? { authorization: `Bearer ${credentials}` } : credentials), 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json() }
  }
  const create = { requestId: randomUUID(), name: 'Deploy reporter' }
  const [one, two] = await Promise.all([request(admin.token, first.id, 'POST', '', create), request(admin.token, first.id, 'POST', '', create)])
  assert.equal(one.status, 200)
  assert.deepEqual(two, one)
  const identity = one.body
  assert.deepEqual(Object.keys(identity).sort(), ['enabled', 'id', 'name', 'revision', 'workspaceId'])
  assert.equal(identity.workspaceId, first.id)
  const item = `/${identity.id}`
  assert.deepEqual((await request(admin.token, first.id, 'GET')).body, { identities: [identity], nextCursor: null })
  assert.deepEqual((await request(admin.token, first.id, 'GET', `?after=${identity.id}`)).body.identities, [])
  assert.deepEqual((await request(admin.token, first.id, 'GET', item)).body, identity)
  assert.equal((await request(admin.token, first.id, 'POST', '', { ...create, name: 'Unrelated creation' })).status, 409)
  assert.equal((await request(ordinary.token, first.id, 'GET')).status, 403)
  assert.equal((await request(ordinary.token, first.id, 'PATCH', item, { action: 'disable', revision: 1 })).status, 403)
  assert.equal((await request(admin.token, second.id, 'GET', item)).status, 403)
  assert.equal((await request(other.token, second.id, 'GET', item)).status, 404)
  assert.equal((await request(other.token, second.id, 'PATCH', item, { action: 'rename', revision: 1, name: 'Other' })).status, 404)
  assert.equal((await request('mkp_invalid', first.id, 'GET')).status, 403)
  assert.deepEqual((await request(other.token, second.id, 'GET')).body.identities, [])

  const auth = await (await import('../lib/auth')).auth.$context
  const session = await auth.internalAdapter.createSession(owner)
  const signature = createHmac('sha256', auth.secret).update(session.token).digest('base64')
  const cookie = auth.authCookies.sessionToken.name + '=' + encodeURIComponent(session.token + '.' + signature)
  const changeName = { action: 'rename', revision: 1, name: 'Release reporter' }
  assert.deepEqual((await request({ cookie }, first.id, 'GET', item)).body, identity)
  assert.equal((await request({ cookie }, first.id, 'PATCH', item, changeName)).status, 403)
  assert.equal((await request({ cookie, origin: 'https://other.invalid' }, first.id, 'PATCH', item, changeName)).status, 403)
  const rename = await request({ cookie, origin }, first.id, 'PATCH', item, changeName)
  assert.equal(rename.body.name, 'Release reporter')
  assert.equal(rename.body.revision, 2)
  assert.equal((await request(admin.token, first.id, 'PATCH', item, { action: 'disable', revision: 1 })).status, 409)
  const disabled = await request(admin.token, first.id, 'PATCH', item, { action: 'disable', revision: 2 })
  assert.equal(disabled.body.enabled, false)
  assert.deepEqual(await request(admin.token, first.id, 'POST', '', create), disabled)
  assert.deepEqual(await request(admin.token, first.id, 'PATCH', item, { action: 'disable', revision: 3 }), disabled)
  const firstTeam = await seedTeam(pool, first.id, owner), otherTeam = await seedTeam(pool, second.id, owner)
  const project = await seedProject(pool, owner, [{ teamId: firstTeam.id, workspaceId: first.id }])
  const otherProject = await seedProject(pool, owner, [{ teamId: otherTeam.id, workspaceId: second.id }])
  const privateProject = await seedProject(pool, member, [{ teamId: firstTeam.id, workspaceId: first.id }])
  await pool.query("UPDATE resource_access_policies SET visibility='private' WHERE kind='project' AND id=$1", [privateProject])
  const projectEndpoint = item + '/projects'
  const assign = { expectedProjectIds: [], projectIds: [project], confirmExpansion: true }
  assert.equal((await request(admin.token, first.id, 'PUT', projectEndpoint, assign)).body.error.detail, 'service_identity_disabled')
  const restored = await request(admin.token, first.id, 'PATCH', item, { action: 'restore', revision: 3 })
  assert.deepEqual(restored.body, { ...rename.body, enabled: true, revision: 4 })
  assert.equal((await request(admin.token, first.id, 'PATCH', item, { action: 'restore', revision: 4, subscription: 'personal' })).status, 400)

  await t.test('project assignment uses the canonical ACL and preserves other principals', async () => {
    const serviceAllowed = async (id: string, kind: string) => (await pool.query(
      "SELECT mikka_resource_acl_allowed('service',$1,$2,'project',$3,$4) AS allowed", [identity.id, first.id, id, kind],
    )).rows[0].allowed
    assert.equal(await serviceAllowed(project, 'canReadContent'), false)
    assert.deepEqual((await request(admin.token, first.id, 'GET', projectEndpoint)).body, { projectIds: [] })
    assert.equal((await request(admin.token, first.id, 'PUT', projectEndpoint, { ...assign, confirmExpansion: false })).status, 409)
    for (const unavailable of [otherProject, privateProject]) {
      assert.equal((await request(admin.token, first.id, 'PUT', projectEndpoint, { ...assign, projectIds: [project, unavailable] })).status, 404)
      assert.equal(await serviceAllowed(project, 'canReadContent'), false)
    }
    assert.equal((await request(ordinary.token, first.id, 'PUT', projectEndpoint, assign)).status, 403)
    const result = await request({ cookie, origin }, first.id, 'PUT', projectEndpoint, assign)
    assert.deepEqual(result, { status: 200, body: { projectIds: [project] } })
    assert.equal(await serviceAllowed(project, 'canReadContent'), true)
    assert.equal(await serviceAllowed(project, 'canUseCredential'), false)
    assert.equal(await serviceAllowed(project, 'canSteer'), false)
    assert.equal((await request(admin.token, first.id, 'PUT', projectEndpoint, assign)).status, 409)
    assert.deepEqual((await request(admin.token, first.id, 'GET', projectEndpoint)).body, { projectIds: [project] })
    await pool.query(`INSERT INTO resource_access_grants ("resourceKind","resourceId","subjectKind","subjectId",capabilities)
      VALUES ('project',$1,'account',$2,ARRAY['canReadContent'])`, [project, member])
    assert.deepEqual((await request(admin.token, first.id, 'PUT', projectEndpoint, { expectedProjectIds: [project], projectIds: [] })).body, { projectIds: [] })
    assert.equal(await serviceAllowed(project, 'canReadContent'), false)
    const { rows: retained } = await pool.query(`SELECT "subjectId" FROM resource_access_grants
      WHERE "resourceKind"='project' AND "resourceId"=$1 AND "subjectKind"='account'`, [project])
    assert.deepEqual(retained, [{ subjectId: member }])
    const { rows: events } = await pool.query(`SELECT action,"actorId" FROM resource_access_events WHERE "resourceKind"='project'
      AND "resourceId"=$1 AND source='service_project_assignment' AND detail->>'subjectId'=$2 ORDER BY revision`, [project, identity.id])
    assert.deepEqual(events, [{ action: 'grant_insert', actorId: owner }, { action: 'grant_delete', actorId: owner }])
  })

  const { rows } = await pool.query('SELECT payload FROM workspace_audit_outbox WHERE "workspaceId"=$1 AND payload->>\'targetId\'=$2 ORDER BY "createdAt",id', [first.id, identity.id])
  assert.deepEqual(rows.map(row => row.payload.action), ['service_identity.created','service_identity.renamed','service_identity.disabled','service_identity.restored'])
  assert.ok(rows.every(row => row.payload.actorId === owner && row.payload.targetType === 'service_identity'))
  await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [first.id, owner])
  assert.equal((await request(admin.token, first.id, 'GET', item)).status, 403)
  assert.equal((await request({ cookie }, first.id, 'GET', item)).status, 403)
})
