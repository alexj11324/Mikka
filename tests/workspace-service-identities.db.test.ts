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

  await t.test('the Project picker exposes manageable names only to a current Workspace admin', async () => {
    const options = projectEndpoint + '?view=choices'
    const response = await request({ cookie }, first.id, 'GET', options)
    assert.equal(response.status, 200)
    const { rows: visible } = await pool.query('SELECT id,name FROM workspace_projects WHERE id=$1', [project])
    assert.deepEqual(response.body, { projects: visible, nextCursor: null })
    assert.deepEqual((await request(admin.token, first.id, 'GET', options + '&after=' + project)).body.projects, [])
    assert.equal((await request(ordinary.token, first.id, 'GET', options)).status, 403)
    assert.equal((await request(other.token, second.id, 'GET', options)).status, 404)
  })

  await t.test('the public Members client manages service identities on the selected server through real HTTP', async clientTest => {
    const { serviceIdentityClient, ServiceIdentityRequestError } = await import('../lib/governance/service-identity-client')
    const { withBasePath } = await import('../lib/base-path')
    const apiPrefix = withBasePath('/api/')
    const directFetch = globalThis.fetch
    const methods = new Set<string>()
    // Node has no page origin or cookie jar. Supply those browser facilities and
    // forward the original method, query and body to the registered HTTP routes.
    clientTest.mock.method(globalThis, 'fetch', (path: string, init: RequestInit) => {
      assert.ok(typeof path === 'string' && path.startsWith(apiPrefix))
      const url = new URL(path, origin)
      assert.equal(url.origin, origin)
      assert.equal(init.credentials, 'same-origin')
      assert.equal(init.cache, 'no-store')
      const method = init.method ?? 'GET'
      methods.add(method)
      const headers = new Headers(init.headers)
      assert.equal(headers.has('authorization'), false)
      headers.set('cookie', cookie)
      if (method !== 'GET') headers.set('origin', origin)
      url.pathname = '/mikka/api/' + url.pathname.slice(apiPrefix.length)
      return directFetch(url, { ...init, headers })
    })
    const client = serviceIdentityClient(first.id)
    const created = await client.create('Public client reporter', randomUUID())
    assert.equal(created.workspaceId, first.id)
    const renamed = await client.change(created, { action: 'rename', name: 'Renamed client reporter' })
    assert.equal((await client.get(created.id)).name, renamed.name)
    assert.deepEqual((await client.choices(created.id)).projects.map(row => row.id), [project])
    assert.deepEqual(await client.replaceProjects(created.id, [], [project], true), { projectIds: [project] })
    assert.deepEqual(await client.projects(created.id), { projectIds: [project] })
    await assert.rejects(client.rotate(created.id, renamed.revision, null, randomUUID()),
      (error: unknown) => error instanceof ServiceIdentityRequestError && error.status === 403)
    const issued = await client.rotate(created.id, renamed.revision, null)
    assert.ok(issued.token.startsWith('mksvc_'))
    const state = await client.credential(created.id)
    assert.equal(state.configured, true)
    assert.equal(Object.hasOwn(state, 'token'), false)
    await assert.rejects(client.revoke(created.id, renamed.revision),
      (error: unknown) => error instanceof ServiceIdentityRequestError && error.status === 409 && error.detail === 'service_identity_changed')
    assert.equal((await client.revoke(created.id, state.revision)).configured, false)
    assert.deepEqual([...methods].sort(), ['GET', 'PATCH', 'POST', 'PUT'])
  })

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

  await t.test('an organization-scoped key requires both administrators and expires with the original attachment', async t => {
    const orgRequest = async (method: string, suffix: string, body: object) => {
      const response = await fetch(origin + '/mikka/api/organizations' + suffix, {
        method, headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      assert.equal(response.status, 200)
      return response.json()
    }
    const firstOrg = (await orgRequest('POST', '', { name: 'Original key organization' })).id
    const otherOrg = (await orgRequest('POST', '', { name: 'Other key organization' })).id
    t.after(async () => {
      await pool.query('DELETE FROM mikka_organizations WHERE id=ANY($1::uuid[])', [[firstOrg, otherOrg]])
      await pool.query(`UPDATE mikka_workspace_members SET role='member' WHERE "workspaceId"=$1 AND "userId"=$2`, [first.id, member])
    })
    const attachment = (organizationId: string, method: string) => orgRequest(method, '/' + organizationId + '/workspaces', { workspaceId: first.id })
    await attachment(firstOrg, 'POST')
    const created = await request({ cookie, origin }, first.id, 'POST', '', { requestId: randomUUID(), name: 'Organization reporter' })
    assert.equal(created.status, 200)
    const resource = '/' + created.body.id
    const credential = resource + '/credential'
    assert.equal((await request({ cookie, origin }, first.id, 'PUT', resource + '/projects', assign)).status, 200)
    const scoped = { action: 'rotate', revision: 1, organizationId: firstOrg }
    const memberSession = await auth.internalAdapter.createSession(member)
    const memberSignature = createHmac('sha256', auth.secret).update(memberSession.token).digest('base64')
    const memberCookie = auth.authCookies.sessionToken.name + '=' + encodeURIComponent(memberSession.token + '.' + memberSignature)
    await pool.query(`UPDATE mikka_workspace_members SET role='admin' WHERE "workspaceId"=$1 AND "userId"=$2`, [first.id, member])
    assert.equal((await request({ cookie: memberCookie, origin }, first.id, 'POST', credential, scoped)).status, 403)
    await pool.query(`UPDATE mikka_workspace_members SET role='member' WHERE "workspaceId"=$1 AND "userId"=$2`, [first.id, member])
    await orgRequest('POST', '/' + firstOrg + '/members', { userId: member, role: 'admin' })
    assert.equal((await request({ cookie: memberCookie, origin }, first.id, 'POST', credential, scoped)).status, 403)
    assert.equal((await request(admin.token, first.id, 'POST', credential, scoped)).status, 403)
    assert.equal((await request({ cookie, origin }, first.id, 'POST', credential, { ...scoped, organizationId: otherOrg })).status, 403)

    const projectRead = async (token: string, suffix = '') => {
      const response = await fetch(origin + '/mikka/api/service-identity/projects' + suffix, { headers: { authorization: 'Bearer ' + token } })
      return response.status
    }
    const issued = await request({ cookie, origin }, first.id, 'POST', credential, scoped)
    assert.equal(issued.status, 200)
    assert.equal(issued.body.organizationId, firstOrg)
    const { rows: audit } = await pool.query(`SELECT payload->'metadata' AS metadata FROM workspace_audit_outbox
      WHERE "workspaceId"=$1 AND payload->>'targetId'=$2 AND payload->>'action'='service_identity.credential_rotated'`, [first.id, created.body.id])
    assert.deepEqual(audit, [{ metadata: { organizationId: firstOrg } }])
    assert.equal((await request({ cookie }, first.id, 'GET', credential)).body.organizationId, firstOrg)
    assert.equal(await projectRead(issued.body.token), 200)
    assert.equal(await projectRead(issued.body.token, '/' + project), 200)
    assert.equal(await projectRead(issued.body.token, '/' + privateProject), 404)

    await attachment(firstOrg, 'DELETE')
    assert.equal(await projectRead(issued.body.token), 401)
    const detached = await request({ cookie }, first.id, 'GET', credential)
    assert.equal(detached.body.configured, false)
    assert.equal(detached.body.revision, 3)
    await attachment(otherOrg, 'POST')
    assert.equal(await projectRead(issued.body.token, '/' + project), 401)
    await attachment(otherOrg, 'DELETE')
    await attachment(firstOrg, 'POST')
    assert.equal(await projectRead(issued.body.token), 401)
    const rebound = await request({ cookie, origin }, first.id, 'POST', credential, { ...scoped, revision: 3 })
    assert.equal(rebound.status, 200)
    assert.equal(await projectRead(rebound.body.token), 200)
    const workspaceOnly = await request({ cookie, origin }, first.id, 'POST', credential, { action: 'rotate', revision: 4 })
    assert.equal(workspaceOnly.status, 200)
    assert.equal(await projectRead(rebound.body.token), 401)
    assert.equal((await request({ cookie }, first.id, 'GET', credential)).body.organizationId, undefined)
    await attachment(firstOrg, 'DELETE')
    assert.equal(await projectRead(workspaceOnly.body.token, '/' + project), 200)
    assert.equal((await request({ cookie, origin }, first.id, 'POST', credential, { action: 'revoke', revision: 5 })).status, 200)
    assert.equal(await projectRead(workspaceOnly.body.token), 401)
  })

  await t.test('an independent service bearer sees only explicit Projects and follows live revocation', async t => {
    const newIdentity = await request({ cookie, origin }, first.id, 'POST', '', { requestId: randomUUID(), name: 'Automation reader' })
    assert.equal(newIdentity.status, 200)
    const serviceId: string = newIdentity.body.id
    const resource = '/' + serviceId
    const credential = resource + '/credential'
    const serviceRead = async (headers: Record<string, string>, after?: string) => {
      const url = origin + '/mikka/api/service-identity/projects' + (after ? '?after=' + after : '')
      const response = await fetch(url, { headers })
      return { status: response.status, data: await response.json(), noStore: response.headers.get('cache-control')?.includes('no-store') }
    }
    const projectDetails = async (headers: Record<string, string>, projectId: string) => {
      const response = await fetch(origin + '/mikka/api/service-identity/projects/' + projectId, { headers })
      assert.match(response.headers.get('cache-control') ?? '', /no-store/)
      return { status: response.status, body: await response.json() }
    }
    const bearer = (token: string) => ({ authorization: 'Bearer ' + token })
    const rotate = (revision: number) => ({ action: 'rotate', revision })
    assert.equal((await serviceRead({ cookie })).status, 401)
    assert.equal((await serviceRead(bearer(admin.token))).status, 401)
    assert.equal((await request(admin.token, first.id, 'POST', credential, rotate(1))).status, 403)
    assert.equal((await request({ cookie }, first.id, 'POST', credential, rotate(1))).status, 403)
    assert.equal((await request({ cookie, origin }, second.id, 'POST', credential, rotate(1))).status, 404)
    const expired = await request({ cookie, origin }, first.id, 'POST', credential, { ...rotate(1), expiresAt: new Date(0).toISOString() })
    assert.equal(expired.status, 400)
    assert.equal(expired.body.error.detail, 'invalid_request')
    const issued = await request({ cookie, origin }, first.id, 'POST', credential, rotate(1))
    assert.equal(issued.status, 200)
    const firstKey: string = issued.body.token
    assert.ok(/^mksvc_[A-Za-z0-9_-]{43}$/.test(firstKey))
    const state = await request(admin.token, first.id, 'GET', credential)
    assert.equal(state.body.configured, true)
    assert.equal(state.body.revision, 2)
    assert.equal('token' in state.body, false)
    const stored = (await pool.query('SELECT "credentialHash" AS digest FROM mikka_workspace_service_identities WHERE id=$1', [serviceId])).rows[0]
    assert.ok(/^[a-f0-9]{64}$/.test(stored.digest))
    assert.ok(stored.digest !== firstKey)
    assert.equal((await request({ cookie, ...bearer(firstKey) }, first.id, 'GET', resource)).status, 401)
    assert.equal((await request({ cookie, origin, ...bearer(firstKey) }, first.id, 'POST', credential, rotate(2))).status, 401)
    assert.deepEqual((await serviceRead(bearer(firstKey))).data.projects, [])
    const grant = await request({ cookie, origin }, first.id, 'PUT', resource + '/projects', assign)
    assert.equal(grant.status, 200)
    const visible = await serviceRead(bearer(firstKey))
    assert.equal(visible.status, 200)
    assert.ok(visible.noStore)
    assert.deepEqual(visible.data, { workspaceId: first.id, serviceIdentityId: serviceId, projects: [{ id: project, name: 'P' }], nextCursor: null })
    assert.deepEqual((await serviceRead(bearer(firstKey), project)).data.projects, [])
    await t.test('the dedicated bearer reads only current, explicitly granted Project details', async () => {
      const fixture = await pool.query('UPDATE workspace_projects SET description=$2 WHERE id=$1 RETURNING name,description,"createdAt","updatedAt"', [project, 'Release notes'])
      await pool.query(`INSERT INTO workspace_project_repositories ("projectId","workspaceId","repositoryKey","baseBranch","isPrimary")
        VALUES ($1,$2,'v2/github.com/example/fixture','release',true), ($1,$2,'/local/legacy-fixture','internal',false),
          ($1,$2,'v2/file/localhost/unit-fixture','internal',false), ($1,$2,' V2/FILE/LOCALHOST/MIXED-CASE ','internal',false)`, [project, first.id])
      const normal = await projectDetails(bearer(firstKey), project)
      assert.equal(normal.status, 200)
      const stored = fixture.rows[0]
      assert.deepEqual(normal.body, {
        id: project, name: stored.name, description: stored.description, visibility: 'shared',
        createdAt: stored.createdAt.toISOString(), updatedAt: stored.updatedAt.toISOString(),
        repositories: [{ repositoryKey: 'v2/github.com/example/fixture', baseBranch: 'release', isPrimary: true }],
      })
      const missing = await projectDetails(bearer(firstKey), randomUUID())
      assert.equal(missing.status, 404)
      for (const unavailable of [otherProject, privateProject]) assert.deepEqual(await projectDetails(bearer(firstKey), unavailable), missing)
      assert.equal((await projectDetails({ cookie }, project)).status, 401)
      assert.equal((await projectDetails(bearer(admin.token), project)).status, 401)
      const detailUrl = origin + '/mikka/api/service-identity/projects/' + project
      for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
        const refused = await fetch(detailUrl, { method, headers: bearer(firstKey) })
        assert.equal(refused.status, 401)
      }
      assert.equal((await fetch(detailUrl + '/environment', { headers: bearer(firstKey) })).status, 401)
      assert.equal((await projectDetails(bearer(firstKey), 'invalid-id')).status, 400)
      await pool.query(`UPDATE resource_access_policies SET "parentKind"='project',"parentId"=$1 WHERE kind='project' AND id=$2`, [privateProject, project])
      try { assert.deepEqual(await projectDetails(bearer(firstKey), project), missing) }
      finally { await pool.query(`UPDATE resource_access_policies SET "parentKind"=NULL,"parentId"=NULL WHERE kind='project' AND id=$1`, [project]) }
      await pool.query('UPDATE workspace_projects SET "archivedAt"=now() WHERE id=$1', [project])
      try { assert.deepEqual(await projectDetails(bearer(firstKey), project), missing) }
      finally { await pool.query('UPDATE workspace_projects SET "archivedAt"=NULL WHERE id=$1', [project]) }
    })
    const orgId = randomUUID()
    await pool.query('INSERT INTO mikka_organizations (id,name,"createdBy") VALUES ($1,$2,$3)', [orgId, 'Service fixture', owner])
    try {
      await pool.query('INSERT INTO mikka_organization_workspaces ("workspaceId","organizationId") VALUES ($1,$2)', [first.id, orgId])
      await pool.query('INSERT INTO enterprise_org_policy ("organizationId","enforceSso","allowMachineCredentials") VALUES ($1,true,false)', [orgId])
      assert.equal((await serviceRead(bearer(firstKey))).status, 401)
      assert.equal((await projectDetails(bearer(firstKey), project)).status, 401)
      await pool.query('UPDATE enterprise_org_policy SET "allowMachineCredentials"=true WHERE "organizationId"=$1', [orgId])
      assert.equal((await serviceRead(bearer(firstKey))).status, 200)
      assert.equal((await projectDetails(bearer(firstKey), project)).status, 200)
      await pool.query('UPDATE enterprise_org_policy SET "archivedAt"=now() WHERE "organizationId"=$1', [orgId])
      assert.equal((await serviceRead(bearer(firstKey))).status, 401)
      assert.equal((await projectDetails(bearer(firstKey), project)).status, 401)
    } finally {
      await pool.query('DELETE FROM enterprise_org_policy WHERE "organizationId"=$1', [orgId])
      await pool.query('DELETE FROM mikka_organizations WHERE id=$1', [orgId])
    }
    const rotated = await request({ cookie, origin }, first.id, 'POST', credential, rotate(2))
    assert.equal(rotated.status, 200)
    const secondKey: string = rotated.body.token
    assert.ok(secondKey && secondKey !== firstKey)
    assert.equal((await serviceRead(bearer(firstKey))).status, 401)
    assert.equal((await projectDetails(bearer(firstKey), project)).status, 401)
    assert.equal((await serviceRead(bearer(secondKey))).status, 200)
    assert.equal((await request({ cookie, origin }, first.id, 'POST', credential, rotate(2))).status, 409)
    await pool.query('UPDATE mikka_workspace_service_identities SET "credentialExpiresAt"=now()-interval \'1 second\' WHERE id=$1', [serviceId])
    assert.equal((await serviceRead(bearer(secondKey))).status, 401)
    const current = await request({ cookie, origin }, first.id, 'POST', credential, rotate(3))
    assert.equal(current.status, 200)
    assert.equal((await request(admin.token, first.id, 'PATCH', resource, { action: 'disable', revision: 4 })).status, 200)
    assert.equal((await serviceRead(bearer(current.body.token))).status, 401)
    assert.equal((await request(admin.token, first.id, 'PATCH', resource, { action: 'restore', revision: 5 })).status, 200)
    assert.equal((await serviceRead(bearer(current.body.token))).status, 401)
    const last = await request({ cookie, origin }, first.id, 'POST', credential, rotate(6))
    assert.equal(last.status, 200)
    assert.equal((await request(admin.token, first.id, 'PUT', resource + '/projects', { expectedProjectIds: [project], projectIds: [] })).status, 200)
    assert.deepEqual((await serviceRead(bearer(last.body.token))).data.projects, [])
    assert.equal((await projectDetails(bearer(last.body.token), project)).status, 404)
    assert.equal((await request(admin.token, first.id, 'POST', credential, { action: 'revoke', revision: 7 })).status, 200)
    assert.equal((await serviceRead(bearer(last.body.token))).status, 401)
    const events = await pool.query('SELECT payload FROM workspace_audit_outbox WHERE "workspaceId"=$1 AND payload->>\'targetId\'=$2', [first.id, serviceId])
    assert.ok(events.rows.some(row => row.payload.action === 'service_identity.credential_revoked'))
    assert.ok(events.rows.every(row => !JSON.stringify(row.payload).includes('mksvc_')))
  })

  const { rows } = await pool.query('SELECT payload FROM workspace_audit_outbox WHERE "workspaceId"=$1 AND payload->>\'targetId\'=$2 ORDER BY "createdAt",id', [first.id, identity.id])
  assert.deepEqual(rows.map(row => row.payload.action), ['service_identity.created','service_identity.renamed','service_identity.disabled','service_identity.restored'])
  assert.ok(rows.every(row => row.payload.actorId === owner && row.payload.targetType === 'service_identity'))
  await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [first.id, owner])
  assert.equal((await request(admin.token, first.id, 'GET', item)).status, 403)
  assert.equal((await request({ cookie }, first.id, 'GET', item)).status, 403)
})
