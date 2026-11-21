import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { mock, test } from 'node:test'
import { Pool } from 'pg'
import { measured } from '../../tests/helpers/read-metrics'
import { dbUrl, seedPersonalWorkspace, seedProject, seedTeam, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'

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
  const scopes = await import('../../app/api/drive/scopes/route')
  const collection = await import('../../app/api/drive/volumes/route')
  const workspaceLinks = await import('../../app/api/drive/shares/route')
  const shareView = await import('../../app/api/drive/shares/[shareId]/route')
  const detail = await import('../../app/api/drive/volumes/[volumeId]/route')
  const upload = await import('../../app/api/drive/volumes/[volumeId]/blobs/route')
  const entries = await import('../../app/api/drive/volumes/[volumeId]/entries/route')
  const file = await import('../../app/api/drive/volumes/[volumeId]/files/route')
  const history = await import('../../app/api/drive/volumes/[volumeId]/versions/route')
  const version = await import('../../app/api/drive/volumes/[volumeId]/versions/[versionId]/route')
  const restore = await import('../../app/api/drive/volumes/[volumeId]/restore/route')
  const archive = await import('../../app/api/drive/volumes/[volumeId]/archive/route')
  const unarchive = await import('../../app/api/drive/volumes/[volumeId]/unarchive/route')
  const links = await import('../../app/api/drive/volumes/[volumeId]/shares/route')
  const link = await import('../../app/api/drive/volumes/[volumeId]/shares/[shareId]/route')
  const handlers = { archive: archive.POST, unarchive: unarchive.POST, blobs: upload.POST, entries: entries.PATCH, files: file.GET, versions: history.GET, restore: restore.POST }
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const request = new Request(`http://${incoming.headers.host}${incoming.url}`, { method: incoming.method,
        headers: incoming.headers as Record<string, string>, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) })
      const segments = new URL(request.url).pathname.split('/').filter(Boolean).slice(3)
      const params = Promise.resolve({ volumeId: segments[0], versionId: segments[2], shareId: segments[2] })
      const pathname = new URL(request.url).pathname
      const response = pathname.startsWith('/api/drive/shares/') ? await shareView.GET(request, { params: Promise.resolve({ shareId: segments[0] }) })
        : pathname === '/api/drive/shares' ? await workspaceLinks.GET(request) : pathname === '/api/drive/scopes' ? await scopes.GET(request) : !segments.length
        ? await (request.method === 'POST' ? collection.POST : collection.GET)(request)
        : segments.length === 1 ? await detail.GET(request, { params })
          : segments[1] === 'shares' ? segments.length === 2
            ? await (request.method === 'POST' ? links.POST : links.GET)(request, { params })
            : await link[request.method as 'GET' | 'PATCH' | 'DELETE'](request, { params })
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
  const call = (suffix = '', options: { token?: string | null; workspaceId?: string; projectId?: string; driveScope?: string; method?: string; body?: unknown; raw?: string; origin?: string } = {}) => {
    const url = new URL(`/api/drive/volumes${suffix}`, origin)
    url.searchParams.set('workspaceId', options.workspaceId ?? personal)
    if (options.projectId) url.searchParams.set('projectId', options.projectId)
    if (options.driveScope) url.searchParams.set('driveScope', options.driveScope)
    const bearer = options.token === undefined ? ownerToken : options.token
    return fetch(url, { method: options.method ?? 'GET', headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(options.method ? { origin: options.origin ?? origin } : {}), ...(options.body ? { 'content-type': 'application/json' } : {}) },
      body: options.raw ?? (options.body ? JSON.stringify(options.body) : undefined) })
  }
  await t.test('Workspace Files follow active membership, protect private bytes and retain a departing member’s storage', async () => {
    const location = { workspaceId: team.id, driveScope: 'team-workspace', token: peerToken }
    const administrator = { ...location, token: sharedToken }
    const personalLocation = { workspaceId: team.id, token: sharedToken }
    const directory = async (workspaceId: string, token: string) =>
      fetch(`${origin}/api/drive/scopes?workspaceId=${workspaceId}&driveScope=team-workspace`, { headers: { authorization: 'Bearer ' + token } })
    assert.deepEqual((await (await directory(team.id, peerToken)).json()).scopes, [{ driveScope: 'team-workspace', workspaceId: team.id }])
    assert.deepEqual((await (await directory(personal, ownerToken)).json()).scopes, [])
    assert.equal((await call('', { workspaceId: personal, driveScope: 'team-workspace' })).status, 404)
    assert.equal((await call('', { ...location, projectId: randomUUID() })).status, 400)
    const create = async (options: typeof personalLocation | typeof location) => {
      const response = await call('', { ...options, method: 'POST', body: { name: 'Team notes' } })
      assert.equal(response.status, 201)
      return (await response.json()).volume
    }
    const volume = await create(location)
    const own = await create(personalLocation)
    assert.equal(volume.driveScope, 'team-workspace')
    assert.equal(volume.scopeId, team.id)
    assert.deepEqual((await (await call('', administrator)).json()).volumes.map((r: {id: string}) => r.id), [volume.id])
    assert.equal((await call('/' + own.id, location)).status, 404)
    assert.equal((await call('/' + volume.id, personalLocation)).status, 404)
    const bytes = 'Shared workspace notes'
    const upload = async (id: string, options: typeof personalLocation | typeof location) => {
      const response = await call('/' + id + '/blobs', { ...options, method: 'POST', raw: bytes })
      assert.equal(response.status, 201)
      return response.json()
    }
    const personalBlob = await upload(own.id, personalLocation)
    const change = { expectedDigest: volume.headDigest, mutationId: randomUUID(), changes: [{ op: 'put', path: 'notes.txt', mode: 0o644, ...personalBlob }] }
    const write = () => call('/' + volume.id + '/entries', { ...location, method: 'PATCH', body: change })
    assert.equal((await write()).status, 422)
    await upload(volume.id, location)
    assert.equal((await write()).status, 200)
    assert.equal((await (await write()).json()).replayed, true)
    assert.equal(await (await call('/' + volume.id + '/files?path=notes.txt', administrator)).text(), bytes)
    assert.equal((await call('/' + volume.id + '/archive', { ...administrator, method: 'POST' })).status, 200)
    assert.equal((await call('/' + volume.id, location)).status, 404)
    assert.equal((await call('/' + volume.id + '/unarchive', { ...location, method: 'POST' })).status, 200)
    assert.equal((await call('/' + volume.id + '/versions', administrator)).status, 200)
    await fixture.query('update mikka_workspace_members set status=\'suspended\' where "workspaceId"=$1 and "userId"=$2', [team.id, peer])
    try {
      assert.equal((await call('/' + volume.id + '/files?path=notes.txt', location)).status, 401)
      assert.equal((await call('/' + volume.id + '/blobs', { ...location, method: 'POST', raw: 'former member' })).status, 401)
      assert.equal(await (await call('/' + volume.id + '/files?path=notes.txt', administrator)).text(), bytes)
    } finally {
      await fixture.query('update mikka_workspace_members set status=\'active\' where "workspaceId"=$1 and "userId"=$2', [team.id, peer])
    }
    const { workspaceDeletionStatements } = await import('../workspace-rows')
    const { accountStorageKeys } = await import('../account/delete')
    const { driveStorageKey } = await import('./blobs')
    const tx = await fixture.connect()
    try {
      await tx.query('BEGIN')
      const principal = 'drive-team:' + team.id
      const key = driveStorageKey(principal, personalBlob.sha256)
      assert.equal((await tx.query('update drive_blobs set "storageKey"=$1,"inlineContent"=null where "ownerId"=$2 and sha256=$3 and "workspaceId"=$4 and "projectId" is null',
        [key, principal, personalBlob.sha256, team.id])).rowCount, 1)
      const leaving = await accountStorageKeys(tx, peer, { solo: [], shared: [team.id], keptIssueIds: [] })
      assert.ok(!leaving.keys.includes(key))
      const sweep = (await workspaceDeletionStatements(tx, team.id)).find(item => item.table === 'drive_blobs' && item.text.includes('"workspaceId"'))
      assert.ok(sweep)
      await tx.query(sweep.text, sweep.values)
      assert.equal((await tx.query('select 1 from chat_attachment_retirements where "teamDriveId"=$1 and "storageKey"=$2', [team.id, key])).rowCount, 1)
      assert.equal((await tx.query('select 1 from drive_blobs where "ownerId"=$1 and sha256=$2', [owner, personalBlob.sha256])).rowCount, 1)
    } finally { await tx.query('ROLLBACK'); tx.release() }
  })
  await t.test('personal Project folders keep their author and require present access to the selected Project', async () => {
    const group = await seedTeam(fixture, team.id, owner)
    const projectId = await seedProject(fixture, owner, [{ teamId: group.id, workspaceId: team.id }])
    const target = { workspaceId: team.id, projectId }
    const own = { ...target, token: sharedToken }
    const colleague = { ...target, token: peerToken }
    const directory = async (token: string) => {
      const res = await fetch(`${origin}/api/drive/scopes?workspaceId=${team.id}`, { headers: { authorization: `Bearer ${token}` } })
      assert.equal(res.status, 200)
      return (await res.json()).scopes as { driveScope: string; projectId?: string }[]
    }
    assert.ok((await directory(peerToken)).some(scope => scope.driveScope === 'project-user' && scope.projectId === projectId))
    const name = 'Project notes'
    const created = await call('', { ...own, method: 'POST', body: { name } })
    assert.equal(created.status, 201)
    const { volume } = await created.json()
    assert.equal(volume.driveScope, 'project-user')
    assert.equal(volume.scopeId, projectId)
    assert.equal(volume.scopeUserId, owner)
    assert.equal((await call('', { ...colleague, method: 'POST', body: { name } })).status, 201)
    assert.equal((await call('/' + volume.id, colleague)).status, 404)
    assert.equal((await call('/' + volume.id, { workspaceId: team.id, token: sharedToken })).status, 404)
    assert.deepEqual((await (await call('', own)).json()).volumes.map((row: { id: string }) => row.id), [volume.id])
    await fixture.query("update resource_access_policies set visibility='private' where kind='project' and id=$1", [projectId])
    assert.deepEqual(await directory(peerToken), [{ driveScope: 'user', workspaceId: team.id }])
    assert.equal((await call('', colleague)).status, 404)
    assert.equal((await call('/' + volume.id + '/versions', own)).status, 200)
    await fixture.query('update workspace_projects set "archivedAt"=now() where id=$1', [projectId])
    assert.deepEqual(await directory(sharedToken), [{ driveScope: 'user', workspaceId: team.id }])
    assert.equal((await call('/' + volume.id + '/versions', own)).status, 404)
  })
  await t.test('explicit shared Project Files use current Project permissions and project-owned bytes', async () => {
    const group = await seedTeam(fixture, team.id, owner)
    const create = () => seedProject(fixture, owner, [{ teamId: group.id, workspaceId: team.id }])
    const projectId = await create(), otherProject = await create()
    const shared = { token: sharedToken, workspaceId: team.id, projectId, driveScope: 'project' }
    const recipient = { ...shared, token: peerToken }, other = { ...shared, projectId: otherProject }
    const privateFiles = { token: sharedToken, workspaceId: team.id, projectId }
    const folder = async (location: typeof privateFiles) => {
      const result = await call('', { ...location, method: 'POST', body: { name: 'Shared test' } })
      assert.equal(result.status, 201)
      return (await result.json()).volume as { id: string; headDigest: string; driveScope: string }
    }
    const { createDriveVolume } = await import('./volumes')
    const legacy = await createDriveVolume(fixture, { ownerId: owner, authorName: 'Historical owner' },
      { driveScope: 'project', workspaceId: team.id, scopeId: projectId, name: 'Shared test' },
      text => createHash('sha256').update(text).digest('hex'))
    const volume = await folder(shared), foreign = await folder(other), privateVolume = await folder(privateFiles)
    assert.equal((await call('/' + legacy.id, shared)).status, 404)
    assert.deepEqual((await (await call('', shared)).json()).volumes.map((row: { id: string }) => row.id), [volume.id])
    assert.equal((await call('', { ...recipient, method: 'POST', body: { name: 'Shared test' } })).status, 409)
    assert.equal(volume.driveScope, 'project')
    assert.equal((await call('/' + volume.id, { ...shared, workspaceId: team.id.toUpperCase(), projectId: projectId.toUpperCase() })).status, 200)
    assert.equal(privateVolume.driveScope, 'project-user')
    assert.equal((await call('/' + volume.id, privateFiles)).status, 404)
    assert.equal((await call('/' + privateVolume.id, recipient)).status, 404)
    assert.equal((await call('/' + foreign.id, recipient)).status, 404)
    const directory = await fetch(`${origin}/api/drive/scopes?workspaceId=${team.id}&driveScope=project`, { headers: { authorization: 'Bearer ' + peerToken } })
    const destinations = (await directory.json()).scopes as { driveScope: string; projectId: string }[]
    assert.ok(destinations.some(scope => scope.projectId === projectId))
    assert.ok(destinations.every(scope => scope.driveScope === 'project'))
    const upload = async (id: string, location: typeof privateFiles, content: string) => {
      const response = await call('/' + id + '/blobs', { ...location, method: 'POST', raw: content })
      assert.equal(response.status, 201)
      return await response.json() as { sha256: string; sizeBytes: number }
    }
    const bytes = 'Explicitly shared project bytes'
    const privateBlob = await upload(privateVolume.id, privateFiles, bytes)
    const foreignBlob = await upload(foreign.id, other, bytes)
    const put = (digest: string, blob: typeof privateBlob) => ({
      expectedDigest: digest, mutationId: randomUUID(), changes: [{ op: 'put', mode: 0o644, path: 'notes.txt', ...blob }],
    })
    const write = (location: typeof privateFiles, content: ReturnType<typeof put>) =>
      call('/' + volume.id + '/entries', { ...location, method: 'PATCH', body: content })
    assert.equal((await write(shared, put(volume.headDigest, privateBlob))).status, 422)
    assert.equal((await write(shared, put(volume.headDigest, foreignBlob))).status, 422)
    const ownBlob = await upload(volume.id, recipient, bytes)
    const change = put(volume.headDigest, ownBlob)
    const applied = await write(recipient, change)
    assert.equal(applied.status, 200)
    assert.equal((await (await write(recipient, change)).json()).replayed, true)
    assert.equal(await (await call('/' + volume.id + '/files?path=notes.txt', shared)).text(), bytes)
    assert.equal((await call('/' + volume.id + '/versions', recipient)).status, 200)
    assert.equal((await call('/' + volume.id + '/files?path=notes.txt', other)).status, 404)
    await fixture.query("update resource_access_policies set visibility='private' where kind='project' and id=$1", [projectId])
    assert.equal((await call('/' + volume.id + '/files?path=notes.txt', recipient)).status, 404)
    await fixture.query(`insert into resource_access_grants("resourceKind","resourceId","subjectKind","subjectId",capabilities)
      values('project',$1,'account',$2,ARRAY['canReadContent'])`, [projectId, peer])
    assert.equal((await call('/' + volume.id + '/files?path=notes.txt', recipient)).status, 200)
    assert.equal((await call('/' + volume.id + '/blobs', { ...recipient, method: 'POST', raw: 'denied' })).status, 404)
    const blobOwners = await fixture.query('select "ownerId","projectId","workspaceId" from drive_blobs where sha256=$1',[ownBlob.sha256])
    assert.equal(blobOwners.rows.length, 3)
    assert.equal(blobOwners.rows.filter(row => row.projectId === projectId && row.workspaceId === team.id && row.ownerId !== owner && row.ownerId !== peer).length, 1)
    const storageOwner = blobOwners.rows.find(row => row.projectId === projectId)!.ownerId
    // Use the real workspace sweep predicate and a synthetic bucket key. No bucket is contacted.
    const { driveStorageKey } = await import('./blobs')
    const key = driveStorageKey(storageOwner, ownBlob.sha256)
    const { workspaceDeletionStatements } = await import('../workspace-rows')
    const outcome = await fixture.connect()
    try {
      await outcome.query('BEGIN')
      await outcome.query('update drive_blobs set "storageKey"=$1,"inlineContent"=null where "ownerId"=$2 and sha256=$3',
        [key, storageOwner, ownBlob.sha256])
      const stagedDigest = createHash('sha256').update(randomUUID()).digest('hex')
      const stagedKey = driveStorageKey(storageOwner, stagedDigest)
      await outcome.query(`insert into drive_blobs("ownerId",sha256,"sizeBytes","storageKey","workspaceId","projectId") values($1,$2,36,$3,$4,$5)`,
        [storageOwner, stagedDigest, stagedKey, team.id, projectId])
      const deletes = await workspaceDeletionStatements(outcome, team.id)
      const blobDelete = deletes.find(item => item.table === 'drive_blobs' && item.text.includes('"workspaceId"'))
      assert.ok(blobDelete)
      const { accountStorageKeys } = await import('../account/delete')
      const retirement = await accountStorageKeys(outcome, peer, { solo: [], shared: [team.id], keptIssueIds: [] })
      assert.ok(!retirement.keys.includes(key), 'the departing contributor must not retire Project storage')
      assert.ok(!retirement.keys.includes(stagedKey), 'the departing contributor must not retire an unreferenced Project upload')
      await outcome.query(blobDelete.text, blobDelete.values)
      assert.equal((await outcome.query('select 1 from chat_attachment_retirements where "projectDriveId"=$1 and "storageKey"=any($2::text[])',
        [projectId, [key, stagedKey]])).rowCount, 2)
      assert.equal((await outcome.query('select 1 from drive_blobs where "ownerId"=$1 and sha256=$2', [owner, privateBlob.sha256])).rowCount, 1)
    } finally {
      await outcome.query('ROLLBACK')
      outcome.release()
    }
  })
  await t.test('Drive Skill metadata uses current authorized files, paginates literal paths and never returns instructions', async () => {
    const group = await seedTeam(fixture, team.id, owner)
    const projectId = await seedProject(fixture, owner, [{ teamId: group.id, workspaceId: team.id }])
    const writer = { token: sharedToken, workspaceId: team.id, projectId, driveScope: 'project' }
    const reader = { ...writer, token: peerToken }
    const volume = (await (await call('', { ...writer, method: 'POST', body: { name: 'Shared skills' } })).json()).volume
    const files = [
      ['SKILL.md', '---\nname: root-guide\ndescription: First guide\n---\nHidden root instructions'],
      ['a fragment/#guide/SKILL.md', '---\nname: "second"\ndescription: Another guide\n---\nInvisible instructions'],
      ['skills/checklist/SKILL.md', '---\nname: display name\ndescription:\nversion: 2\n---\nPrivate body must stay out of the directory'],
      ['b/SKILL.md', 'bad\0binary'], ['big/SKILL.md', 'a'.repeat(20_001)], ['not-SKILL.md', 'not metadata'],
    ]
    const changes = []
    for (const [path, content] of files) {
      const response = await call('/' + volume.id + '/blobs', { ...writer, method: 'POST', raw: content })
      assert.equal(response.status, 201)
      changes.push({ op: 'put', mode: 0o644, path, ...await response.json() })
    }
    const publish = await call('/' + volume.id + '/entries', { ...writer, method: 'PATCH',
      body: { expectedDigest: volume.headDigest, mutationId: randomUUID(), changes } })
    assert.equal(publish.status, 200)
    const receipt = await publish.json()
    const first = await (await call('?view=skills&limit=1', reader)).json()
    assert.deepEqual(first.skills, [{ volumeId: volume.id, versionId: receipt.headVersionId, path: 'SKILL.md', name: 'root-guide', description: 'First guide' }])
    const next = new URLSearchParams({ view: 'skills', afterVolume: first.nextCursor.volumeId, afterPath: first.nextCursor.path })
    const second = await (await call('?' + next, reader)).json()
    assert.deepEqual(second.skills, [
      { volumeId: volume.id, versionId: receipt.headVersionId, path: 'a fragment/#guide/SKILL.md', name: 'second', description: 'Another guide' },
      { volumeId: volume.id, versionId: receipt.headVersionId, path: 'skills/checklist/SKILL.md', name: 'checklist', description: '' },
    ])
    assert.equal(second.nextCursor, null)
    assert.deepEqual(await (await call('?view=skills', { token: sharedToken, workspaceId: team.id, projectId })).json(), { skills: [], nextCursor: null })
    assert.equal((await call('?view=skills', { ...writer, token: null })).status, 401)
    assert.equal((await call('?view=skills&afterPath=SKILL.md', writer)).status, 400)
    assert.equal((await call('?view=skills&threadId=' + randomUUID(), writer)).status, 400)
    const removed = await call('/' + volume.id + '/entries', { ...writer, method: 'PATCH', body: {
      expectedDigest: receipt.headDigest, mutationId: randomUUID(), changes: [{ op: 'delete', path: 'SKILL.md' }],
    } })
    assert.equal(removed.status, 200)
    assert.deepEqual((await (await call('?view=skills', reader)).json()).skills.map((row: { name: string }) => row.name), ['second', 'checklist'])
    assert.equal((await call('/' + volume.id + '/archive', { ...writer, method: 'POST' })).status, 200)
    assert.deepEqual(await (await call('?view=skills', reader)).json(), { skills: [], nextCursor: null })
    await fixture.query("update resource_access_policies set visibility='private' where kind='project' and id=$1", [projectId])
    assert.equal((await call('?view=skills', reader)).status, 404)
  })
  const created = await call('', { method: 'POST', body: { name: `Drive ${randomUUID()}` } })
  assert.equal(created.status, 201)
  const volume = (await created.json()).volume
  const duplicate = await call('', { method: 'POST', body: { name: volume.name } })
  assert.equal(duplicate.status, 409)
  // Measure the point lookups used to open a single folder. Match only SELECTs
  // of the volume row; membership, immutable versions and session reads remain independent.
  const selectRows = pool.query.bind(pool)
  let volumeLookups = 0
  const lookup = t.mock.method(pool, 'query', (...args: Parameters<typeof pool.query>) => {
    const [sql] = args
    if (typeof sql === 'string' && /FROM\s+drive_volumes\b/i.test(sql)) volumeLookups++
    return selectRows(...args)
  })
  try {
    const open = await call(`/${volume.id}`)
    assert.equal(open.status, 200)
    assert.equal((await open.json()).volume.id, volume.id)
    assert.equal(volumeLookups, 1, 'open one folder with one authorized volume row lookup')
  } finally { lookup.mock.restore() }
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
  const writeA = { expectedDigest: fresh.head.headDigest, mutationId: randomUUID(), changes: [
    { op: 'put', path: 'notes/result.txt', mode: 0o644, ...blobA },
    ...Array.from({ length: 192 }, (_, index) => ({ op: 'put', path: 'other/file-' + index, mode: 0o644, ...blobA })),
  ] }
  const written = await call(`/${volume.id}/entries`, { method: 'PATCH', body: writeA })
  assert.equal(written.status, 200)
  const first = await written.json()
  assert.equal((await (await call(`/${volume.id}/entries`, { method: 'PATCH', body: writeA })).json()).replayed, true)
  const conflict = await call(`/${volume.id}/entries`, { method: 'PATCH', body: { ...writeA, mutationId: randomUUID() } })
  assert.equal(conflict.status, 409)
  assert.equal((await conflict.json()).headDigest, first.headDigest)
  const readSingle = await measured(() => file.GET(
    new Request(`${origin}/api/drive/volumes/${volume.id}/files?workspaceId=${personal}&path=notes%2Fresult.txt`, { headers: { authorization: `Bearer ${ownerToken}` } }),
    { params: Promise.resolve({ volumeId: volume.id }) },
  ))
  assert.equal(await readSingle.value.text(), 'first file bytes')
  assert.ok(readSingle.resultBytes < 12_000, 'one download must not transfer unrelated manifest entries')
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
  const duplicatePath = await call(`/${volume.id}/entries`, { method: 'PATCH', body: {
    expectedDigest: restoredBody.headDigest, mutationId: randomUUID(),
    changes: [{ op: 'delete', path: 'same.txt' }, { op: 'delete', path: 'same.txt' }],
  } })
  assert.equal(duplicatePath.status, 422)
  assert.equal(duplicatePath.headers.get('cache-control'), 'private, no-store')
  assert.equal(duplicatePath.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(await duplicatePath.json(), { error: 'drive_write_invalid' })
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
  await t.test('archive retains a personal volume and its immutable versions until its owner reopens it', async () => {
    const active = await (await call(`/${volume.id}`)).json()
    const versions = (await (await call(`/${volume.id}/versions`)).json()).versions
    for (const action of ['archive', 'unarchive']) {
      assert.equal((await call(`/${volume.id}/${action}`, { method: 'POST', token: null })).status, 401)
      assert.equal((await call(`/${volume.id}/${action}`, { method: 'POST', token: sharedToken, workspaceId: team.id })).status, 404)
      assert.equal((await call(`/${otherVolume.id}/${action}`, { method: 'POST', token: peerToken, workspaceId: team.id })).status, 404)
      assert.equal((await call(`/${volume.id}/${action}`, { method: 'POST', origin: 'https://other.invalid' })).status, 403)
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await call(`/${volume.id}/archive`, { method: 'POST' })
      assert.equal(result.status, 200)
      assert.deepEqual(await result.json(), { archived: true })
    }
    const listIds = async (path: string) => (await (await call(path)).json()).volumes.map((v: { id: string }) => v.id)
    assert.ok(!(await listIds('')).includes(volume.id))
    assert.deepEqual(await listIds('?archived=true'), [volume.id])
    for (const suffix of ['', '/versions', '/versions?path=notes%2Fresult.txt', `/versions/${first.headVersionId}`, '/files?path=notes%2Fresult.txt']) {
      assert.equal((await call(`/${volume.id}${suffix}`)).status, 404)
    }
    assert.equal((await call(`/${volume.id}/entries`, { method: 'PATCH', body: writeA })).status, 404)
    assert.equal((await call(`/${volume.id}/restore`, { method: 'POST', body: { versionId: first.headVersionId, expectedDigest: active.head.headDigest, mutationId: randomUUID() } })).status, 404)
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await call(`/${volume.id}/unarchive`, { method: 'POST' })
      assert.equal(result.status, 200)
      assert.deepEqual(await result.json(), { archived: false })
    }
    assert.ok((await listIds('')).includes(volume.id))
    assert.deepEqual(await listIds('?archived=true'), [])
    assert.deepEqual((await (await call(`/${volume.id}`)).json()).head, active.head)
    assert.deepEqual((await (await call(`/${volume.id}/versions`)).json()).versions, versions)
    const oldFile = await call(`/${volume.id}/files?path=notes%2Fresult.txt&versionId=${first.headVersionId}`)
    assert.equal(oldFile.status, 200)
    assert.equal(await oldFile.text(), 'first file bytes')
  })

  const edits = await call(`/${volume.id}/entries`, { method: 'PATCH', body: {
    expectedDigest: restoredBody.headDigest, mutationId: randomUUID(),
    changes: [{ op: 'put', path: 'unrelated.txt', mode: 0o644, ...blobA }],
  } })
  assert.equal(edits.status, 200)
  const unrelated = await edits.json()
  const deletion = await call(`/${volume.id}/entries`, { method: 'PATCH', body: {
    expectedDigest: unrelated.headDigest, mutationId: randomUUID(), changes: [{ op: 'delete', path: 'notes/result.txt' }],
  } })
  assert.equal(deletion.status, 200)
  const fileHistory = `/${volume.id}/versions?path=notes%2Fresult.txt`
  const firstChanges = await (await call(fileHistory + '&limit=2')).json()
  assert.deepEqual(firstChanges.versions.map((v: { seq: number }) => v.seq), [6, 4],
    'single-file history records a deletion and restore while excluding an unrelated edit')
  assert.equal(firstChanges.versions[0].file, null)
  assert.deepEqual(firstChanges.versions[1].file, current.head.entries[0])
  const earlierChanges = await (await call(fileHistory + '&limit=2&before=' + firstChanges.nextCursor)).json()
  assert.deepEqual(earlierChanges.versions.map((v: { seq: number }) => v.seq), [3, 2])
  assert.equal(earlierChanges.versions[0].file.sha256, blobB.sha256)
  assert.equal(earlierChanges.nextCursor, null)
  assert.deepEqual(await (await call(`/${volume.id}/versions?path=missing.txt`)).json(), { versions: [], nextCursor: null })
  assert.equal((await call(`/${volume.id}/versions?path=`)).status, 400)
  assert.equal((await call(fileHistory, { token: null })).status, 401)
  assert.equal((await call(fileHistory, { token: sharedToken, workspaceId: team.id })).status, 404)
  assert.equal((await call(fileHistory, { token: peerToken, workspaceId: team.id })).status, 404)
  await t.test('volume history follows commit sequence across independent version-ID generators', async () => {
    const create = await call('', { method: 'POST', body: { name: 'Version order fixture' } })
    assert.equal(create.status, 201)
    const { volume: volumeWithHistory } = await create.json()
    // Two committed checkpoints have IDs from the same millisecond on different workers.
    // Their random suffixes sort in the opposite order to their commits.
    const prefix = 'vver_0000000001' + randomUUID().replaceAll('-', '').slice(0, 15).toUpperCase()
    const secondId = prefix + 'Z', thirdId = prefix + '0'
    await fixture.query(`
      WITH checkpoints AS (
        INSERT INTO drive_volume_versions (id, "volumeId", "ownerId", seq, kind, "fileCount", "totalBytes", digest, manifest, "authorName")
        SELECT point.id, seed."volumeId", seed."ownerId", point.seq, 'checkpoint', seed."fileCount", seed."totalBytes",
               seed.digest, seed.manifest, seed."authorName"
          FROM drive_volume_versions seed
          CROSS JOIN (VALUES ($2::text, 2), ($3::text, 3)) AS point(id, seq)
         WHERE seed.id=$1
        RETURNING id, "volumeId", seq
      )
      UPDATE drive_volumes volume SET "headVersionId"=checkpoints.id
        FROM checkpoints WHERE volume.id=checkpoints."volumeId" AND checkpoints.seq=3`,
    [volumeWithHistory.headVersionId, secondId, thirdId])

    const historyPath = `/${volumeWithHistory.id}/versions?limit=2`
    const firstPage = await call(historyPath)
    assert.equal(firstPage.status, 200)
    const page = await firstPage.json()
    assert.deepEqual(page.versions.map((version: { id: string }) => version.id), [thirdId, secondId])
    assert.equal(page.nextCursor, secondId)

    const nextPage = await call(historyPath + '&before=' + page.nextCursor)
    assert.equal(nextPage.status, 200)
    const rest = await nextPage.json()
    assert.deepEqual(rest.versions.map((version: { id: string }) => version.id), [volumeWithHistory.headVersionId])
    assert.equal(rest.nextCursor, null)

    const foreignCursor = await call(historyPath + '&before=' + volume.headVersionId)
    assert.equal(foreignCursor.status, 200)
    assert.deepEqual(await foreignCursor.json(), { versions: [], nextCursor: null })
  })

  await t.test('signed-in Drive file links default to the creator, follow live Drive membership and expire when the path is removed', async context => {
    const mine = { workspaceId: team.id, token: sharedToken }
    const teamDrive = { ...mine, driveScope: 'team-workspace' }
    const member = { ...teamDrive, token: peerToken }
    async function makeFile(location: typeof mine) {
      const volume = (await (await call('', { ...location, method: 'POST', body: { name: randomUUID() } })).json()).volume
      const blob = await (await call('/' + volume.id + '/blobs', { ...location, method: 'POST', raw: 'selected file' })).json()
      const change = { op: 'put', path: 'notes.txt', mode: 0o644, ...blob }
      const entries = '/' + volume.id + '/entries'
      const write = (head: string, changes: unknown[]) => call(entries, { ...location, method: 'PATCH',
        body: { expectedDigest: head, mutationId: randomUUID(), changes } })
      const applied = await (await write(volume.headDigest, [change])).json()
      return { collection: '/' + volume.id + '/shares', write, head: applied.headDigest, change }
    }
    const { collection, write, head, change } = await makeFile(teamDrive)
    const create = () => call(collection, { ...teamDrive, method: 'POST', body: { path: 'notes.txt' } })
    const created = (await (await create()).json()).link
    assert.equal(created.visibility, 'private')
    const address = collection + '/' + created.id
    assert.equal(await (await call(address, teamDrive)).text(), 'selected file')
    assert.equal((await call(address, member)).status, 404)
    assert.equal((await (await call(collection + '?path=notes.txt', member)).json()).link, null)
    assert.equal((await call(address, { ...teamDrive, method: 'PATCH', body: { visibility: 'public' } })).status, 400)
    const visibility = (location: typeof mine, value: string) => call(address, { ...location, method: 'PATCH', body: { visibility: value } })
    assert.equal((await visibility(teamDrive, 'org')).status, 200)
    assert.deepEqual((await (await create()).json()).link, { ...created, visibility: 'org' })
    assert.equal(await (await call(address, member)).text(), 'selected file')
    assert.equal((await visibility(member, 'private')).status, 404)
    await context.test('create, update and volume listing return the same stored share metadata under the existing reader access', async () => {
      const id = collection.split('/')[1]
      const { rows: [expected] } = await fixture.query('SELECT l."createdAt",u.name FROM drive_file_links l JOIN "user" u ON u.id=l."createdBy" WHERE l.id=$1', [created.id])
      assert.equal(created.volumeId, id)
      assert.equal(created.manageable, true)
      assert.equal(created.createdBy, expected.name)
      assert.equal(Date.parse(created.createdAt), expected.createdAt.getTime())
      const canonical = new URL(created.url, origin)
      assert.equal(canonical.origin, origin)
      assert.equal(canonical.pathname, '/api/drive/volumes' + address)
      assert.equal(canonical.searchParams.get('workspaceId'), team.id)
      assert.equal(canonical.searchParams.get('driveScope'), 'team-workspace')
      assert.equal(await (await fetch(canonical, { headers: { authorization: 'Bearer ' + peerToken } })).text(), 'selected file')
      const changed = (await (await visibility(teamDrive, 'org')).json()).link
      assert.deepEqual(changed, { ...created, visibility: 'org' })
      const received = (await (await call(collection, member)).json()).links
      assert.deepEqual(received, [{ ...changed, manageable: false }])
      const own = (await (await call(collection + '?path=notes.txt', teamDrive)).json()).link
      assert.deepEqual(own, changed)
    })
    await context.test('a paged Drive link directory lists only readable links with their real manager', async () => {
      const other = (await (await call(collection, { ...member, method: 'POST', body: { path: 'notes.txt' } })).json()).link
      const ownerDirectory = await (await call(collection, teamDrive)).json()
      assert.deepEqual(ownerDirectory.links, [{ ...created, visibility: 'org', manageable: true }])
      const first = await (await call(collection + '?limit=1', member)).json()
      assert.equal(first.links.length, 1)
      assert.equal(first.nextCursor, first.links[0].id)
      const second = await (await call(collection + '?limit=1&after=' + first.nextCursor, member)).json()
      assert.equal(second.nextCursor, null)
      const links: { id: string; manageable: boolean }[] = [...first.links, ...second.links]
      assert.deepEqual(links.map(link => link.id), [created.id, other.id].sort())
      assert.equal(links.find(link => link.id === other.id)?.manageable, true)
      assert.equal(links.find(link => link.id === created.id)?.manageable, false)
      // Links created before the timestamp migration keep their unknown date.
      await fixture.query('UPDATE drive_file_links SET "createdAt"=NULL WHERE id=$1', [other.id])
      const retried = (await (await call(collection, { ...member, method: 'POST', body: { path: 'notes.txt' } })).json()).link
      assert.deepEqual(retried, { ...other, createdAt: null })
      await call(collection + '/' + other.id, { ...member, method: 'DELETE' })
      assert.deepEqual((await (await call(collection, member)).json()).links, [{ ...created, visibility: 'org', manageable: false }])
    })
    await fixture.query("update mikka_workspace_members set status='suspended' where \"workspaceId\"=$1 and \"userId\"=$2", [team.id, peer])
    try { assert.equal((await call(address, member)).status, 401) }
    finally { await fixture.query("update mikka_workspace_members set status='active' where \"workspaceId\"=$1 and \"userId\"=$2", [team.id, peer]) }
    assert.equal((await visibility(teamDrive, 'private')).status, 200)
    assert.equal((await call(address, member)).status, 404)
    assert.equal((await call(address, { ...teamDrive, method: 'DELETE' })).status, 200)
    assert.equal((await call(address, teamDrive)).status, 404)
    const next = (await (await create()).json()).link
    assert.notEqual(next.id, created.id)
    const removed = await (await write(head, [{ op: 'delete', path: 'notes.txt' }])).json()
    assert.equal((await write(removed.headDigest, [change])).status, 200)
    assert.equal((await call(collection + '/' + next.id, teamDrive)).status, 404)
    const privateFile = await makeFile(mine)
    const onlyOwner = (await (await call(privateFile.collection, { ...mine, method: 'POST', body: { path: 'notes.txt' } })).json()).link
    assert.equal((await call(privateFile.collection + '/' + onlyOwner.id, { ...mine, method: 'PATCH', body: { visibility: 'org' } })).status, 422)
    assert.equal((await call(privateFile.collection + '/' + onlyOwner.id, { ...mine, token: peerToken })).status, 404)
    await context.test('a Workspace link directory intersects creator visibility, active Project ACL and file location before pagination', async directoryContext => {
      const myDirectory = (token: string, workspaceId: string = team.id, suffix = '') => fetch(
        origin + '/api/drive/shares?workspaceId=' + workspaceId + suffix, { headers: { authorization: 'Bearer ' + token } })
      const group = await seedTeam(fixture, team.id, owner)
      const projectId = await seedProject(fixture, owner, [{ teamId: group.id, workspaceId: team.id }])
      const shared = { ...mine, projectId, driveScope: 'project' }
      const projectUser = { ...mine, projectId }
      const makeLink = async (location: typeof mine, audience: 'private' | 'org') => {
        const f = await makeFile(location)
        const { link } = await (await call(f.collection, { ...location, method: 'POST', body: { path: 'notes.txt' } })).json()
        if (audience === 'org') assert.equal((await call(f.collection + '/' + link.id, { ...location, method: 'PATCH', body: { visibility: audience } })).status, 200)
        return link.id as string
      }
      const teamLink = await makeLink(teamDrive, 'org'), projectLink = await makeLink(shared, 'org')
      const projectPrivate = await makeLink(projectUser, 'private')
      const actual = async (token: string) => (await (await myDirectory(token)).json()).links as { id: string; driveScope: string; projectId: string | null; manageable: boolean }[]
      const mineLinks = await actual(sharedToken)
      assert.deepEqual(mineLinks.map(l => l.id).sort(), [onlyOwner.id, teamLink, projectLink, projectPrivate].sort())
      assert.equal(mineLinks.find(l => l.id === projectPrivate)?.driveScope, 'project-user')
      assert.equal(mineLinks.find(l => l.id === teamLink)?.projectId, null)
      const received = await actual(peerToken)
      assert.deepEqual(received.map(l => l.id).sort(), [teamLink, projectLink].sort())
      assert.ok(received.every(l => !l.manageable))
      const first = await (await myDirectory(peerToken, team.id, '&limit=1')).json()
      const second = await (await myDirectory(peerToken, team.id, '&limit=1&page=2')).json()
      assert.deepEqual([first.page, first.pageCount, first.total, second.page, second.pageCount, second.total], [1, 2, 2, 2, 2, 2])
      const last = await (await myDirectory(peerToken, team.id, '&limit=1&page=8')).json()
      assert.deepEqual(last, second)
      assert.deepEqual([first.links[0].id, second.links[0].id], [teamLink, projectLink].sort())
      const view = (id: string, token: string, selected?: string) => fetch(`${origin}/api/drive/shares/${id}`, { headers: {
        authorization: 'Bearer ' + token, ...(selected && { 'x-mikka-workspace-id': selected }),
      } })
      await directoryContext.test('one share ID resolves the current file version and expiring bytes only under the original membership', async () => {
        const base = await (await view(teamLink, peerToken)).json()
        assert.equal(base.type, 'file')
        assert.equal(base.id, teamLink)
        assert.equal(base.path, 'notes.txt')
        assert.equal(base.visibility, 'org')
        assert.equal(base.orgName, null)
        assert.equal(base.member, null)
        assert.equal(base.authorName, (await fixture.query('SELECT name FROM "user" WHERE id=$1', [owner])).rows[0].name)
        assert.match(base.versionId, /^vver_/)
        assert.ok(Number.isFinite(Date.parse(base.versionCreatedAt)))
        assert.equal(base.sizeBytes, Buffer.byteLength('selected file'))
        assert.equal(base.file.type, 'url')
        assert.ok(Date.parse(base.file.expiresAt) > Date.now())
        const bytes = (path: string, token: string) => fetch(new URL(path, origin), { headers: { authorization: 'Bearer ' + token } })
        assert.equal(await (await bytes(base.file.url, peerToken)).text(), 'selected file')
        assert.equal((await bytes(base.file.url, sharedToken)).status, 404)
        assert.equal((await view(teamLink, peerToken, personal)).status, 404)
        assert.equal((await view(teamLink, ownerToken)).status, 404)
        assert.equal((await view(projectPrivate, peerToken)).status, 404)
        assert.equal((await fetch(new URL(base.url, origin))).status, 401)
        assert.equal((await fetch(new URL(base.file.url, origin))).status, 401)
        const expired = new URL(base.file.url, origin)
        const proof = expired.searchParams.get('download')!
        const { requireCurrentDownload } = await import('./share-view')
        const fileDigest = createHash('sha256').update('selected file').digest('hex')
        const expiresAt = Date.parse(base.file.expiresAt)
        // The signing replica's clock can be ahead of the download replica.
        // A genuine credential is usable immediately and stops exactly at expiry.
        requireCurrentDownload(proof, teamLink, peer, fileDigest, expiresAt - 5 * 60_000 - 1000)
        assert.throws(() => requireCurrentDownload(proof, teamLink, peer, fileDigest, expiresAt), /drive_not_found/)

        expired.searchParams.set('download', proof.replace(/^\d+/, String(Date.now() - 1)))
        assert.equal((await bytes(expired.href, peerToken)).status, 404)
        const callerExpiry = new URL(base.url, origin)
        callerExpiry.searchParams.set('expiresAt', String(expiresAt + 60_000))
        assert.equal((await bytes(callerExpiry.href, peerToken)).status, 400)
        callerExpiry.searchParams.delete('expiresAt')
        callerExpiry.searchParams.set('issuedAt', String(Date.now()))
        assert.equal((await bytes(callerExpiry.href, peerToken)).status, 400)
        const extended = new URL(base.file.url, origin)
        extended.searchParams.set('download', proof.replace(/^\d+/, String(expiresAt + 60_000)))
        assert.equal((await bytes(extended.href, peerToken)).status, 404)
        const listing = (await (await myDirectory(sharedToken)).json()).links.find((item: { id: string }) => item.id === teamLink)
        const visibility = (value: 'private' | 'org') => fetch(new URL(listing.url, origin), { method: 'PATCH',
          headers: { origin, authorization: 'Bearer ' + sharedToken, 'content-type': 'application/json' }, body: JSON.stringify({ visibility: value }) })
        assert.equal((await visibility('private')).status, 200)
        assert.equal((await bytes(base.file.url, peerToken)).status, 404)
        assert.equal((await visibility('org')).status, 200)
        assert.equal(await (await bytes(base.file.url, peerToken)).text(), 'selected file')
        await fixture.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [team.id, peer])
        try { assert.equal((await bytes(base.file.url, peerToken)).status, 401) }
        finally { await fixture.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"=$2`, [team.id, peer]) }
        const orgId = randomUUID()
        await fixture.query('INSERT INTO mikka_organizations(id,name,"createdBy") VALUES($1,$2,$3)', [orgId, 'Drive schema owner', owner])
        try {
          await fixture.query('INSERT INTO mikka_organization_workspaces("workspaceId","organizationId") VALUES($1,$2)', [team.id, orgId])
          await fixture.query(`INSERT INTO mikka_organization_members("organizationId","userId",role,status,name,email)
            VALUES($1,$2,'owner','active','Owner','owner@example.test')`, [orgId, owner])
          const joined = await (await view(projectLink, sharedToken)).json()
          assert.equal(joined.orgName, 'Drive schema owner')
          assert.deepEqual(joined.member, { orgId, manageable: true, projectId, userId: null, automationId: null })
          const workspaceOnly = await (await view(projectLink, peerToken)).json()
          assert.equal(workspaceOnly.orgName, null)
          assert.equal(workspaceOnly.member, null)
        } finally { await fixture.query('DELETE FROM mikka_organizations WHERE id=$1', [orgId]) }
      })
      await directoryContext.test('shared file directory metadata follows its actual path change, stable creation and current signed-in address', async () => {
        const link = () => myDirectory(peerToken).then(r => r.json()).then(page => page.links.find((item: {id: string}) => item.id === teamLink))
        const original = await link()
        const author = (await fixture.query('select name from "user" where id=$1', [owner])).rows[0].name
        assert.equal(original.createdBy, author)
        assert.ok(Number.isFinite(Date.parse(original.createdAt)))
        assert.ok(Number.isFinite(Date.parse(original.changedAt)))
        const signedInTarget = new URL(original.url, origin)
        assert.equal(signedInTarget.origin, origin)
        assert.equal(signedInTarget.searchParams.get('driveScope'), 'team-workspace')
        assert.equal(await (await fetch(signedInTarget, { headers: { authorization: 'Bearer ' + peerToken } })).text(), 'selected file')
        const volume = '/' + original.volumeId
        const write = async (path: string, mode: number) => {
          const head = (await (await call(volume, teamDrive)).json()).head
          const entry = head.entries.find((item: {path: string}) => item.path === original.path)
          return call(volume + '/entries', { ...teamDrive, method: 'PATCH', body: { expectedDigest: head.headDigest,
            mutationId: randomUUID(), changes: [{ op: 'put', path, mode, sha256: entry.sha256, sizeBytes: entry.sizeBytes }] } })
        }
        assert.equal((await write('unrelated.txt', 0o644)).status, 200)
        assert.equal((await link()).changedAt, original.changedAt)
        const viewBeforeMode = await (await view(teamLink, peerToken)).json()
        assert.equal(Date.parse(viewBeforeMode.versionCreatedAt), Date.parse(original.changedAt))
        assert.equal((await write(original.path, 0o755)).status, 200)
        const modified = await link()
        assert.ok(Date.parse(modified.changedAt) > Date.parse(original.changedAt))
        assert.equal(modified.createdAt, original.createdAt)
        const viewAfterMode = await (await view(teamLink, peerToken)).json()
        assert.notEqual(viewAfterMode.versionId, viewBeforeMode.versionId)
        assert.equal(Date.parse(viewAfterMode.versionCreatedAt), Date.parse(modified.changedAt))
        // Fixture a pre-upgrade row: its link creation date is unknown but the
        // current file's last change can be recovered from immutable history.
        await fixture.query('update drive_file_links set "createdAt"=null where id=$1', [teamLink])
        await fixture.query('update drive_volume_entries set "changedAt"=null where "volumeId"=$1 and path=$2', [original.volumeId, original.path])
        const historic = await link()
        assert.equal(historic.createdAt, null)
        assert.equal(historic.changedAt, modified.changedAt)
      })
      await directoryContext.test('organization volume catalogs page active scopes and count only each reader’s admitted immutable heads', async () => {
        const { organizationDriveScopeDirectory, listOrganizationDriveVolumes } = await import('./organization-volumes')
        const organization = randomUUID()
        await fixture.query('INSERT INTO mikka_organizations(id,name,"createdBy") VALUES($1,$2,$3)', [organization, 'Volume catalog', owner])
        try {
          await fixture.query(`INSERT INTO mikka_organization_members("organizationId","userId",role,name,email)
            SELECT $1,id,'member',name,email FROM "user" WHERE id=ANY($2::text[])`, [organization, [owner, peer]])
          await fixture.query('INSERT INTO mikka_organization_workspaces("workspaceId","organizationId") VALUES ($1,$2)', [team.id, organization])
          const scopes = (reader: string, query = '') => organizationDriveScopeDirectory(organization, reader, 'catalog-unit-session', new URLSearchParams(query))
          const volumes = (reader: string, query = '') => listOrganizationDriveVolumes(organization, reader, 'catalog-unit-session', new URLSearchParams(query))
          const current = await volumes(peer, 'exactScope=true&projectId=' + projectId)
          assert.ok(current.length > 0)
          assert.ok(current.every(v => v.projectId === projectId && v.workspaceId === team.id && v.driveScope === 'project' && v.userId === null))
          const scope = await scopes(peer, 'projectId=' + projectId)
          assert.equal(scope.storage, null)
          assert.equal(scope.totalScopes, 2)
          const sharedScope = scope.items.find(v => v.driveScope === 'project')!
          assert.equal(sharedScope.fileCount, current.reduce((n, v) => n + v.fileCount, 0))
          assert.equal(sharedScope.totalBytes, current.reduce((n, v) => n + v.totalBytes, 0))
          assert.equal(Date.parse(sharedScope.headUpdatedAt!), Math.max(...current.map(v => Date.parse(v.headUpdatedAt))))
          assert.equal(current[0].namespace, 'drive-project:' + team.id + ':' + projectId)
          const privateVolumes = await volumes(owner, 'exactScope=true&projectId=' + projectId + '&userId=' + owner)
          assert.ok(privateVolumes.length > 0)
          assert.ok(privateVolumes.every(v => v.userId === owner && v.driveScope === 'project-user'))
          assert.deepEqual(await volumes(peer, 'exactScope=true&projectId=' + projectId + '&userId=' + owner), [])
          assert.deepEqual(await volumes(peer, 'automationId=not-a-drive-scope'), [])
          assert.deepEqual(await volumes(peer, 'captainJamId=not-a-drive-scope'), [])
          assert.equal((await scopes(peer, 'automationId=absent')).totalScopes, 0)
          await assert.rejects(async () => await scopes(peer, 'page=1&page=2'))
          await assert.rejects(async () => await volumes(peer, 'archived=not-a-boolean'))
          const ownerScopes = await scopes(owner)
          const extraWorkspace = await seedWorkspace(fixture, owner, [{ userId: owner, role: 'admin' }])
          await fixture.query('INSERT INTO mikka_organization_workspaces("workspaceId","organizationId") VALUES ($1,$2)', [extraWorkspace.id, organization])
          const aggregate = await scopes(owner)
          assert.equal(aggregate.totalScopes, ownerScopes.totalScopes)
          assert.equal(aggregate.items.filter(row => row.projectId === null && row.userId === null).length, 1)
          const created = []
          for (let i = 0; i < 26; i++) created.push(await seedProject(fixture, owner, [{ teamId: group.id, workspaceId: team.id }]))
          const first = await scopes(peer)
          const second = await scopes(peer, 'page=2')
          assert.equal(first.items.length, 50)
          assert.ok(second.items.length > 0)
          const keys = (page: typeof first) => page.items.map(v => [v.projectId, v.userId, v.automationId].join('/'))
          assert.ok(keys(second).every(key => !keys(first).includes(key)))
          const empty = await scopes(peer, 'projectId=' + created[0])
          assert.equal(empty.items.length, 2)
          assert.ok(empty.items.every(v => v.fileCount === 0 && v.totalBytes === 0 && v.headUpdatedAt === null))
          await fixture.query("UPDATE resource_access_policies SET visibility='private' WHERE kind='project' AND id=$1", [projectId])
          assert.equal((await scopes(peer, 'projectId=' + projectId)).totalScopes, 0)
          assert.deepEqual(await volumes(peer, 'projectId=' + projectId), [])
          await fixture.query("UPDATE resource_access_policies SET visibility='shared' WHERE kind='project' AND id=$1", [projectId])
          await fixture.query('DELETE FROM mikka_organization_workspaces WHERE "organizationId"=$1 AND "workspaceId"=$2', [organization, team.id])
          assert.equal((await scopes(peer)).totalScopes, 0)
          assert.deepEqual(await volumes(peer), [])
        } finally {
          await fixture.query('DELETE FROM mikka_organizations WHERE id=$1', [organization])
        }
      })
      await directoryContext.test('organization directory pins attached Workspaces and active Projects before counting readable links', async () => {
        const { listOrganizationFileLinks } = await import('./organization-file-links')
        const organization = randomUUID()
        await fixture.query('insert into mikka_organizations(id,name,"createdBy") values($1,$2,$3)', [organization, 'Files', owner])
        await fixture.query(`insert into mikka_organization_members("organizationId","userId",role,name,email)
          select $1,id,'member',name,email from "user" where id=any($2::text[])`, [organization, [owner, peer]])
        await fixture.query('insert into mikka_organization_workspaces("workspaceId","organizationId") values($1,$2)', [team.id, organization])
        try {
          const list = () => listOrganizationFileLinks(organization, peer, 'drive-directory-unit-session', 1)
          const directory = await list()
          assert.equal(directory.total, 2)
          assert.deepEqual(directory.items.map(item => item.id), [teamLink, projectLink].sort())
          assert.ok(directory.items.every(item => !item.manageable && item.userId === null && item.automationId === null))
          const projectItem = directory.items.find(item => item.id === projectLink)!
          assert.equal(projectItem.projectId, projectId)
          assert.equal(new URL(projectItem.url, origin).searchParams.get('workspaceId'), team.id)

          // With the archive uncommitted the reader must wait at the canonical
          // Project lock. The resumed directory excludes it from items and count.
          const writer = await fixture.connect()
          let commit = false
          try {
            await writer.query('begin')
            await writer.query('update workspace_projects set "archivedAt"=now() where id=$1', [projectId])
            const writerPid = (await writer.query('select pg_backend_pid() as pid')).rows[0].pid
            const pending = list()
            const deadline = Date.now() + 5000
            let waiting = false
            while (!waiting && Date.now() < deadline) {
              const result = await fixture.query(`select exists(select 1 from pg_stat_activity
                where $1::int=any(pg_blocking_pids(pid)) and query like '%FROM workspace_projects p%') as waiting`, [writerPid])
              waiting = result.rows[0].waiting
              if (!waiting) await new Promise(resolve => setTimeout(resolve, 20))
            }
            await writer.query('commit')
            commit = true
            const after = await pending
            assert.equal(waiting, true)
            assert.deepEqual(after.items.map(item => item.id), [teamLink])
            assert.equal(after.total, 1)
          } finally {
            if (!commit) await writer.query('rollback')
            writer.release()
            await fixture.query('update workspace_projects set "archivedAt"=null where id=$1', [projectId])
          }
          await fixture.query('delete from mikka_organization_workspaces where "organizationId"=$1', [organization])
          assert.equal((await list()).total, 0)
        } finally {
          await fixture.query('delete from mikka_organizations where id=$1', [organization])
        }
      })
      const peerDownload = (await (await view(projectLink, peerToken)).json()).file.url
      const ownerDownload = (await (await view(projectLink, sharedToken)).json()).file.url
      const redeem = (path: string, token: string) => fetch(new URL(path, origin), { headers: { authorization: 'Bearer ' + token } })
      await fixture.query("update resource_access_policies set visibility='private' where kind='project' and id=$1", [projectId])
      assert.deepEqual((await actual(peerToken)).map(l => l.id), [teamLink])
      assert.equal((await view(projectLink, peerToken)).status, 404)
      assert.equal((await redeem(peerDownload, peerToken)).status, 404)
      await fixture.query('update workspace_projects set "archivedAt"=now() where id=$1', [projectId])
      assert.deepEqual((await actual(sharedToken)).map(l => l.id).sort(), [onlyOwner.id, teamLink].sort())
      assert.equal((await myDirectory(ownerToken, personal)).status, 404)
      assert.equal((await view(projectLink, sharedToken)).status, 404)
      assert.equal((await redeem(ownerDownload, sharedToken)).status, 404)
    })

  })

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
