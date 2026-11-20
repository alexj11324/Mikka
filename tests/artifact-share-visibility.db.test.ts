import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import type { CreatedArtifactShare } from '@mikka/protocol/artifact-share'
import type { ShareVisibility } from '@mikka/protocol/settings'
import { withActivitySession } from './fixtures/activity-runtime.mjs'
import { dbUrl, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('artifact links freeze defaults and enforce their scope at metadata and HTML byte boundaries', { skip: !dbUrl }, async t => {
  const [{ pool }, { workspacePool }, actions, metadata, frame, settings, store] = await Promise.all([
    import('../lib/db'), import('../lib/workspace-db'), import('../app/actions/artifacts'),
    import('../app/api/artifacts/shared/[token]/route'), import('../app/api/artifacts/shared/[token]/frame/route'),
    import('../lib/settings/store'), import('../lib/artifacts/store'),
  ])
  pool.options.max = 1
  workspacePool.options.max = 1
  const users: string[] = [], workspaces: string[] = []
  t.after(async () => {
    try {
      await pool.query('DELETE FROM artifacts WHERE "userId"=ANY($1::text[])', [users])
      await pool.query('DELETE FROM workspace_setting_values WHERE "workspaceId"=ANY($1::uuid[])', [workspaces])
      await workspacePool.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [workspaces])
      await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [users])
    } finally {
      await (await import('../lib/builtin-gateway/runtime')).builtinGateway()?.stop()
      await Promise.all([pool.end(), workspacePool.end()])
    }
  })
  const owner = await seedUser(pool, 'artifact-admin'), member = await seedUser(pool, 'artifact-member'), outsider = await seedUser(pool, 'artifact-outsider')
  users.push(owner, member, outsider)
  const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: member, role: 'member' }])
  const other = await seedWorkspace(pool, outsider, [{ userId: outsider, role: 'admin' }])
  workspaces.push(workspace.id, other.id)
  const as = <T>(userId: string, work: () => Promise<T>, workspaceId = workspace.id) => withActivitySession(userId, work, workspaceId)
  const artifact = async (kind: 'markdown' | 'html', userId = owner, workspaceId = workspace.id) => {
    const id = randomUUID(), content = kind === 'html' ? '<main>Restricted artifact bytes</main>' : '# Restricted artifact text'
    await pool.query('INSERT INTO artifacts (id,"userId","workspaceId",kind,title) VALUES ($1,$2,$3,$4,\'Scoped fixture\')', [id, userId, workspaceId, kind])
    await pool.query('INSERT INTO artifact_versions (id,"artifactId",version,"storageKey","inlineContent",sha256,size,"authorName") VALUES ($1,$2,1,$3,$4,$5,$6,\'Fixture\')',
      [randomUUID(), id, `fixture/${id}`, content, createHash('sha256').update(content).digest('hex'), Buffer.byteLength(content)])
    return { id, content }
  }
  const html = await artifact('html'), markdown = await artifact('markdown'), foreign = await artifact('html', outsider, other.id)
  const create = async (artifactId: string, visibility?: ShareVisibility): Promise<CreatedArtifactShare> => {
    const result = await as(owner, () => actions.shareArtifact(artifactId, visibility))
    assert.ok('token' in result, JSON.stringify(result))
    return result
  }
  const open = (token: string, reader: string | null, kind: 'metadata' | 'frame' = 'metadata') => {
    const request = new Request(`http://localhost/api/artifacts/shared/${token}${kind === 'frame' ? '/frame' : ''}`, {
      headers: reader ? { cookie: 'artifact-fixture=present' } : undefined,
    })
    const call = () => (kind === 'frame' ? frame.GET : metadata.GET)(request, { params: Promise.resolve({ token }) })
    return reader ? as(reader, call, reader === outsider ? other.id : workspace.id) : call()
  }
  const setDefault = (value: ShareVisibility | null) => settings.writeSettings({ userId: owner, workspaceId: workspace.id }, 'workspace', { values: { artifactShareVisibility: value } })
  let inheritedPrivate: CreatedArtifactShare, inheritedLink: CreatedArtifactShare

  await t.test('defaults affect new links only; explicit choices freeze separately and server input stays guarded', async () => {
    inheritedLink = await create(html.id)
    assert.deepEqual({ scope: inheritedLink.scope, source: inheritedLink.source }, { scope: { visibility: 'link', workspaceId: workspace.id }, source: 'default' })
    await setDefault('private')
    inheritedPrivate = await create(html.id)
    assert.deepEqual({ scope: inheritedPrivate.scope, source: inheritedPrivate.source }, { scope: { visibility: 'private', workspaceId: workspace.id }, source: 'workspace' })
    const explicit = await create(html.id, 'workspace')
    assert.deepEqual({ scope: explicit.scope, source: explicit.source }, { scope: { visibility: 'workspace', workspaceId: workspace.id }, source: 'explicit' })
    await setDefault('link')
    assert.equal((await open(inheritedPrivate.token, null)).status, 404)
    assert.equal((await open(inheritedLink.token, null)).status, 200)
    await setDefault(null)
    assert.equal((await create(html.id)).source, 'default')
    const invalid = await as(owner, () => actions.shareArtifact(html.id, 'public' as ShareVisibility))
    assert.equal('error' in invalid && invalid.error, 'validationGeneric')
    const invalidId = await as(owner, () => actions.shareArtifact('not-a-uuid'))
    assert.equal('error' in invalidId && invalidId.error, 'validationGeneric')
    const { desktopActionSchemas } = await import('../lib/desktop-rpc/schemas')
    const schema = desktopActionSchemas['artifacts.shareArtifact']
    assert.equal(schema.safeParse([html.id]).success, true)
    assert.equal(schema.safeParse([html.id, 'workspace']).success, true)
    assert.equal(schema.safeParse([html.id, 'public']).success, false)
  })

  await t.test('creating a link still requires artifact ownership in the admitted workspace', async () => {
    const unsigned = await actions.shareArtifact(html.id)
    assert.equal('error' in unsigned && unsigned.error, 'authRequired')
    for (const id of [member, outsider]) {
      const denied = await as(id, () => actions.shareArtifact(html.id), id === outsider ? other.id : workspace.id)
      assert.equal('error' in denied && denied.error, 'artifactNotFound')
    }
    const crossTenant = await as(owner, () => actions.shareArtifact(foreign.id))
    assert.equal('error' in crossTenant && crossTenant.error, 'artifactNotFound')
    const { tokenWorkspace } = await import('../lib/tokens/principal')
    assert.equal(await store.createShare({ id: owner, [tokenWorkspace]: other.id }, html.id, 'link'), null)
    const own = await artifact('markdown', member)
    const allowed = await as(member, () => actions.shareArtifact(own.id, 'workspace'))
    assert.ok('token' in allowed, 'an ordinary member may share their own artifact without changing administrator defaults')
  })

  await t.test('both HTTP readers enforce private/workspace/link scopes and keep denied bytes indistinguishable', async () => {
    for (const visibility of ['private', 'workspace', 'link'] as const) {
      const share = await create(html.id, visibility)
      for (const reader of [null, owner, member, outsider]) {
        const allowed = visibility === 'link' || reader === owner || visibility === 'workspace' && reader === member
        for (const kind of ['metadata', 'frame'] as const) {
          const response = await open(share.token, reader, kind)
          assert.equal(response.status, allowed ? 200 : 404, `${visibility}/${reader ?? 'anonymous'}/${kind}`)
          assert.equal(response.headers.get('cache-control'), 'private, no-store')
          const body = await response.text()
          assert.equal(body.includes(html.content), allowed && kind === 'frame')
          if (!allowed) assert.equal(body, kind === 'frame' ? 'Not found' : '{"error":"not_found"}')
          if (kind === 'frame') assert.match(response.headers.get('content-security-policy')!, /sandbox allow-scripts/)
        }
      }
    }
    const text = await create(markdown.id, 'workspace')
    const admitted = await open(text.token, member)
    assert.equal((await admitted.json()).markdown, markdown.content)
    assert.equal((await open(text.token, null)).status, 404)
    assert.equal((await open(text.token, member, 'frame')).status, 404)
    const spoofed = new Request(`http://localhost/api/artifacts/shared/${text.token}?userId=${owner}`, { headers: { cookie: 'unverified=1' } })
    assert.equal((await metadata.GET(spoofed, { params: Promise.resolve({ token: text.token }) })).status, 404)
  })

  await t.test('viewer suspension/removal, issuer suspension and explicit revocation close metadata and frames', async () => {
    const scoped = await create(html.id, 'workspace')
    const updateMember = (userId: string, status: string) => workspacePool.query('UPDATE mikka_workspace_members SET status=$3 WHERE "workspaceId"=$1 AND "userId"=$2', [workspace.id, userId, status])
    await updateMember(member, 'suspended')
    for (const kind of ['metadata', 'frame'] as const) assert.equal((await open(scoped.token, member, kind)).status, 404)
    await workspacePool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [workspace.id, member])
    for (const kind of ['metadata', 'frame'] as const) assert.equal((await open(scoped.token, member, kind)).status, 404)
    await workspacePool.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,\'member\',\'active\')', [workspace.id, member, `${member}@example.invalid`])
    assert.equal((await open(scoped.token, member)).status, 200)
    await updateMember(owner, 'suspended')
    for (const token of [scoped.token, inheritedPrivate.token, inheritedLink.token]) {
      for (const kind of ['metadata', 'frame'] as const) assert.equal((await open(token, member, kind)).status, 404)
    }
    await updateMember(owner, 'active')
    assert.equal((await open(scoped.token, member)).status, 200)
    const revoked = await as(owner, () => actions.stopSharingArtifact(html.id))
    assert.ok('revoked' in revoked && revoked.revoked > 0)
    for (const kind of ['metadata', 'frame'] as const) assert.equal((await open(scoped.token, member, kind)).status, 404)
  })

  await t.test('the additive migration preserves old links, rejects invalid scope and repeats without changing explicit rows', async () => {
    const schema = `artifact_share_upgrade_${randomUUID().replaceAll('-', '')}`
    const migration = await readFile(new URL('../drizzle/20261120193615_artifact_share_visibility.sql', import.meta.url), 'utf8')
    const client = await pool.connect()
    try {
      await client.query(`CREATE SCHEMA "${schema}"`)
      await client.query(`SET search_path TO "${schema}",public`)
      await client.query('CREATE TABLE artifact_shares (id uuid PRIMARY KEY, "artifactId" uuid NOT NULL, "tokenHash" text NOT NULL, "createdBy" text NOT NULL, "revokedAt" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now())')
      const legacy = randomUUID()
      await client.query('INSERT INTO artifact_shares (id,"artifactId","tokenHash","createdBy") VALUES ($1,$2,\'hash-only\',$3)', [legacy, html.id, owner])
      const before = (await client.query('SELECT * FROM artifact_shares')).rows[0]
      await client.query(migration)
      assert.deepEqual((await client.query('SELECT * FROM artifact_shares')).rows[0], { ...before, visibility: 'link' })
      await assert.rejects(client.query('UPDATE artifact_shares SET visibility=\'public\''), { code: '23514' })
      await client.query('UPDATE artifact_shares SET visibility=\'private\'')
      await client.query(migration)
      assert.deepEqual((await client.query('SELECT * FROM artifact_shares')).rows[0], { ...before, visibility: 'private' })
    } finally {
      await client.query('SET search_path TO public')
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      client.release()
    }
  })
})
