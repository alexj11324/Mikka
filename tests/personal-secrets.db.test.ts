// 设置 › 密钥与登录 › 我的: a person's own secrets against a real PostgreSQL (decision 2026-11-02-2120).
// Uses a random per-run WORKSPACE_SECRETS_KEY only.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedAgent, seedPersonalWorkspace, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('personal secrets', { skip: !dbUrl }, async t => {
  const previousKey = process.env.WORKSPACE_SECRETS_KEY
  process.env.WORKSPACE_SECRETS_KEY = randomBytes(32).toString('hex')
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  const { WorkspaceError } = await import('../lib/workspace-access')
  const personal = await import('../lib/secrets/user-store')
  const store = await import('../lib/secrets/store')
  const runtime = await import('../lib/secrets/runtime')
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  t.after(async () => {
    if (previousKey === undefined) delete process.env.WORKSPACE_SECRETS_KEY; else process.env.WORKSPACE_SECRETS_KEY = previousKey
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })
  const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof WorkspaceError && error.code === code)
  const alex = await seedUser(pool, 'alex'), lin = await seedUser(pool, 'lin')
  const ws = await seedWorkspace(pool, alex, [{ userId: alex, role: 'admin' }, { userId: lin, role: 'member' }])
  const VALUE = 'sk_personal_' + randomBytes(12).toString('hex')
  const META = ['delivery', 'id', 'kind', 'name', 'note', 'updatedAt']
  const DIRECT = { mode: 'direct', exposeToAgent: true } as const
  const privateRuns = new Map<string, string>()
  const privateContext = async (ownerId: string, workspaceId: string = ws.id) => {
    const key = `${workspaceId}:${ownerId}`
    let runId = privateRuns.get(key)
    if (!runId) {
      runId = randomUUID()
      const agentId = await seedAgent(pool, ownerId)
      await pool.query('insert into agent_runs(id,"userId","workspaceId","agentId",status) values($1,$2,$3,$4,\'queued\')', [runId, ownerId, workspaceId, agentId])
      await pool.query('update resource_access_policies set visibility=\'private\' where kind=\'thread\' and id=$1', [runId])
      privateRuns.set(key, runId)
    }
    return { runId }
  }

  await t.test('owner-only: list, create, replace, delete; ids of others are indistinguishable from missing ones', async () => {
    const saved = await personal.createUserSecret(alex, { name: 'OPENROUTER_API_KEY', kind: 'secret', value: VALUE, note: '测试用' }, { workspaceId: ws.id })
    assert.deepEqual(Object.keys(saved).filter(key => key !== 'warning').sort(), META)
    assert.ok(!JSON.stringify(saved).includes(VALUE))
    assert.deepEqual((await personal.listUserSecrets(alex)).map(row => [row.name, row.note]), [['OPENROUTER_API_KEY', '测试用']])
    assert.deepEqual(await personal.listUserSecrets(lin), [])
    await rejects(personal.replaceUserSecret(lin, { id: saved.id, value: 'stolen-value-1' }), 'secretNotFound')
    await rejects(personal.deleteUserSecret(lin, { id: saved.id }), 'secretNotFound')
    const noted = await personal.replaceUserSecret(alex, { id: saved.id, note: '换了说明' })
    assert.equal(noted.note, '换了说明')
    await rejects(personal.createUserSecret(alex, { name: 'OPENROUTER_API_KEY', kind: 'secret', value: VALUE }, { workspaceId: ws.id }), 'secretNameTaken')
    await rejects(personal.createUserSecret(alex, { name: 'PATH', kind: 'env', value: '/usr/bin' }, { workspaceId: ws.id }), 'secretNameReserved')
    const { rows } = await pool.query('select * from user_secrets where id=$1', [saved.id])
    assert.ok(!JSON.stringify(rows).includes(VALUE), 'ciphertext only')
    assert.deepEqual(await personal.deleteUserSecret(alex, { id: saved.id }), { id: saved.id })
    assert.deepEqual(await personal.listUserSecrets(alex), [])
  })

  await t.test('a personal name a workspace secret already has asks once; confirmed, the personal value wins in the owner\'s runs only', async () => {
    await store.createWorkspaceSecret(alex, ws.id, { name: 'VERCEL_TOKEN', kind: 'secret', value: 'team-value-1234', delivery: DIRECT })
    await store.createWorkspaceSecret(alex, ws.id, { name: 'REPO_ONLY', kind: 'secret', value: 'repo-value-1234', scope: { type: 'repository', repository: 'alexj11324/mikka' }, delivery: DIRECT })
    await rejects(personal.createUserSecret(alex, { name: 'VERCEL_TOKEN', kind: 'secret', value: 'alex-value-1234' }, { workspaceId: ws.id }), 'secretNameShadowsWorkspace')
    await rejects(personal.createUserSecret(alex, { name: 'REPO_ONLY', kind: 'secret', value: 'alex-repo-1234' }, { workspaceId: ws.id }), 'secretNameShadowsWorkspace')
    await personal.createUserSecret(alex, { name: 'VERCEL_TOKEN', kind: 'secret', value: 'alex-value-1234', overrideWorkspace: true, delivery: DIRECT }, { workspaceId: ws.id })
    await personal.createUserSecret(alex, { name: 'ALEX_ONLY', kind: 'env', value: 'plain-config' }, { workspaceId: ws.id })

    const alexRun = await runtime.taskSecretInjection(ws.id, 'alexj11324/mikka', process.env, undefined, alex, await privateContext(alex))
    assert.equal(alexRun.env.VERCEL_TOKEN, 'alex-value-1234', 'personal beats workspace')
    assert.equal(alexRun.env.REPO_ONLY, 'repo-value-1234')
    assert.equal(alexRun.env.ALEX_ONLY, 'plain-config')
    assert.deepEqual(alexRun.secretNames.sort(), ['REPO_ONLY', 'VERCEL_TOKEN'], 'only masked kinds are secret names')
    const linRun = await runtime.taskSecretInjection(ws.id, 'alexj11324/mikka', process.env, undefined, lin, await privateContext(lin))
    assert.equal(linRun.env.VERCEL_TOKEN, 'team-value-1234', 'another member never gets it')
    assert.equal(linRun.env.ALEX_ONLY, undefined)
    const noOwner = await runtime.taskSecretInjection(ws.id, null)
    assert.equal(noOwner.env.VERCEL_TOKEN, 'team-value-1234')

    const masker = await runtime.secretMaskerFor({ workspaceId: ws.id, ownerId: alex })
    assert.ok(!masker('token alex-value-1234 and team-value-1234').includes('alex-value-1234'))
    assert.ok(!masker('team-value-1234').includes('team-value-1234'))
    assert.ok(masker('plain-config').includes('plain-config'), 'env kind stays readable')
    const masked = await runtime.maskFor({ workspaceId: ws.id, ownerId: alex }, { out: 'echo alex-value-1234' })
    assert.ok(!JSON.stringify(masked).includes('alex-value-1234'))
  })

  await t.test('bulk add for oneself: names and line errors back, never values; a workspace name is reported, not shadowed silently', async () => {
    const result = await personal.importUserSecrets(lin, { text: 'LIN_ONE=lin-value-0001 # 第一\nPATH=/x\nVERCEL_TOKEN=lin-shadow-1', masked: true, onConflict: 'skip' }, { workspaceId: ws.id })
    assert.deepEqual(result, { created: ['LIN_ONE'], replaced: [], kept: [], errors: [{ line: 2, name: 'PATH', reason: 'reserved' }, { line: 3, name: 'VERCEL_TOKEN', reason: 'shadowsWorkspace' }] })
    const confirmed = await personal.importUserSecrets(lin, { text: 'VERCEL_TOKEN=lin-shadow-1', masked: true, onConflict: 'skip', overrideWorkspace: true }, { workspaceId: ws.id })
    assert.deepEqual(confirmed.created, ['VERCEL_TOKEN'])
    assert.ok(!JSON.stringify([result, confirmed]).includes('lin-value-0001'))
  })

  await t.test('personal delivery stays protected until its owner explicitly approves one secret; approval cannot be forged or bulk imported', async () => {
    const row = await personal.createUserSecret(alex, { name: 'PERSONAL_DELIVERY', kind: 'secret', value: VALUE }, {})
    assert.deepEqual(row.delivery, { mode: 'protected' })
    await rejects(personal.replaceUserSecret(lin, { id: row.id, delivery: DIRECT }), 'secretNotFound')
    await assert.rejects(personal.replaceUserSecret(alex, { id: row.id, delivery: { mode: 'direct' } }))
    await assert.rejects(personal.replaceUserSecret(alex, { id: row.id, delivery: { ...DIRECT, approvedAt: new Date().toISOString() } }))
    const now = new Date('2026-11-08T12:00:00.000Z')
    const direct = await personal.replaceUserSecret(alex, { id: row.id, delivery: DIRECT }, now)
    assert.deepEqual(direct.delivery, { ...DIRECT, approvedBy: alex, approvedAt: now.toISOString() })
    const http = { origin: 'https://api.example.com', header: 'x-api-key', prefix: '', rules: [{ method: 'POST', path: '/v1/', match: 'prefix' }] }
    const protectedRow = await personal.replaceUserSecret(alex, { id: row.id, delivery: { mode: 'protected', http } })
    assert.deepEqual(protectedRow.delivery, { mode: 'protected', http })
    await assert.rejects(personal.importUserSecrets(alex, { text: 'PERSONAL_DELIVERY=rotated-secret', masked: true, onConflict: 'replace', delivery: DIRECT }, {}))
    await personal.importUserSecrets(alex, { text: 'PERSONAL_DELIVERY=rotated-secret\nPERSONAL_IMPORT=protected-secret', masked: true, onConflict: 'replace' }, {})
    const rows = await personal.listUserSecrets(alex)
    assert.deepEqual(rows.find(entry => entry.id === row.id)?.delivery, protectedRow.delivery)
    assert.deepEqual(rows.find(entry => entry.name === 'PERSONAL_IMPORT')?.delivery, { mode: 'protected' })
    const ordinary = await personal.createUserSecret(alex, { name: 'PERSONAL_REGION', kind: 'env', value: 'eu' }, {})
    assert.equal(ordinary.delivery, undefined)
    await rejects(personal.replaceUserSecret(alex, { id: ordinary.id, delivery: DIRECT }), 'validationGeneric')
    await assert.rejects(pool.query('update user_secrets set delivery=$2 where id=$1', [row.id, { mode: 'direct' }]), (error: unknown) => (error as { code?: string }).code === '23514')
    assert.ok(!JSON.stringify([row, direct, protectedRow, rows]).includes(VALUE), 'only metadata leaves the store')
    for (const entry of rows.filter(entry => entry.name === 'PERSONAL_DELIVERY' || entry.name === 'PERSONAL_IMPORT')) await personal.deleteUserSecret(alex, { id: entry.id })
    await personal.deleteUserSecret(alex, { id: ordinary.id })
  })

  await t.test('the shadow check needs membership of the workspace it reads', async () => {
    const other = await seedWorkspace(pool, alex, [{ userId: alex, role: 'admin' }])
    await rejects(personal.createUserSecret(lin, { name: 'ANY_NAME', kind: 'secret', value: 'value-1234' }, { workspaceId: other.id }), 'workspaceAccessDenied')
  })

  await t.test('a personal protected override blocks lower-scope direct delivery and is usable only by its owner', async () => {
    const name = 'PERSONAL_PROTECTED_OVERRIDE'
    await store.createWorkspaceSecret(alex, ws.id, { name, kind: 'secret', value: 'workspace-direct-canary', delivery: DIRECT })
    const own = await personal.createUserSecret(alex, { name, kind: 'secret', value: VALUE, overrideWorkspace: true }, { workspaceId: ws.id })
    const mine = await runtime.taskSecretInjection(ws.id, null, process.env, undefined, alex, await privateContext(alex))
    assert.equal(mine.env[name], undefined, 'protected personal metadata must not expose either value')
    assert.ok(mine.unavailable.includes(name))
    const teammate = await runtime.taskSecretInjection(ws.id, null, process.env, undefined, lin, await privateContext(lin))
    assert.equal(teammate.env[name], 'workspace-direct-canary')
    assert.ok(!JSON.stringify(teammate).includes(VALUE))
    const personalWorkspace = await seedPersonalWorkspace(pool, alex)
    const personalOnly = await runtime.taskSecretInjection(personalWorkspace, null, process.env, undefined, alex, await privateContext(alex, personalWorkspace))
    assert.equal(personalOnly.env[name], undefined)
    assert.ok(personalOnly.unavailable.includes(name))
    const unbound = await runtime.taskSecretInjection(null, null, process.env, undefined, alex)
    assert.deepEqual(unbound.unavailable, [], 'an Owner id without a real private run does not authorize personal values')
    await personal.deleteUserSecret(alex, { id: own.id })
  })

  await t.test('a moved row fails to open; deleting the account deletes its secrets', async () => {
    const temp = await seedUser(pool, 'temp')
    const saved = await personal.createUserSecret(temp, { name: 'TEMP_KEY', kind: 'secret', value: 'temp-value-1234' }, {})
    await pool.query('update user_secrets set "userId"=$2 where id=$1', [saved.id, alex])
    await assert.rejects(runtime.taskSecretInjection(ws.id, null, process.env, undefined, alex, await privateContext(alex)))
    await pool.query('delete from user_secrets where id=$1', [saved.id])
    await personal.createUserSecret(temp, { name: 'TEMP_KEY', kind: 'secret', value: 'temp-value-1234' }, {})
    await pool.query('delete from "user" where id=$1', [temp])
    assert.equal((await pool.query('select count(*)::int as n from user_secrets where "userId"=$1', [temp])).rows[0].n, 0)
  })

  await t.test('personal create, rotation, policy changes, imports and deletion revoke only the owner\'s admitted runs', async () => {
    const owner = await seedUser(pool, 'secret-owner'), teammate = await seedUser(pool, 'secret-teammate')
    const consumer = async (userId: string, status = 'running') => {
      const runId = randomUUID(), deviceId = randomUUID(), agentId = await seedAgent(pool, userId)
      const workspaceId = await seedPersonalWorkspace(pool, userId)
      await pool.query('insert into devices (id,"ownerId",name,kind) values ($1,$2,$3,\'local\')', [deviceId, userId, 'personal-secret-consumer'])
      await pool.query('insert into agent_runs (id,"userId","agentId","deviceId",status,"leaseExpiresAt","workspaceId") values ($1,$2,$3,$4,$5,now()+interval \'10 minutes\',$6)', [runId, userId, agentId, deviceId, status, workspaceId])
      return runId
    }
    const stopped = async (id: string) => (await pool.query('select "stopRequestedAt" is not null as stopped,"leaseExpiresAt"<=now() as expired from agent_runs where id=$1', [id])).rows[0]
    const foreign = await consumer(teammate), queued = await consumer(owner, 'queued'), first = await consumer(owner)
    const row = await personal.createUserSecret(owner, { name: 'REVOKE_PERSONAL', kind: 'secret', value: VALUE }, {})
    assert.deepEqual(await stopped(first), { stopped: true, expired: true })
    const second = await consumer(owner)
    await personal.replaceUserSecret(owner, { id: row.id, note: 'metadata only' })
    assert.equal((await stopped(second)).stopped, false)
    await personal.replaceUserSecret(owner, { id: row.id, value: VALUE + '-rotated' })
    assert.deepEqual(await stopped(second), { stopped: true, expired: true })
    const third = await consumer(owner)
    const approved = await personal.replaceUserSecret(owner, { id: row.id, delivery: DIRECT })
    assert.deepEqual(await stopped(third), { stopped: true, expired: true })
    const fourth = await consumer(owner)
    const annotated = await personal.replaceUserSecret(owner, { id: row.id, note: 'approved delivery is unchanged' })
    assert.deepEqual(annotated.delivery, approved.delivery, 'JSONB key ordering does not alter the approval')
    assert.deepEqual(await stopped(fourth), { stopped: false, expired: false }, 'note-only edits of a stored direct policy do not revoke the run')
    await personal.importUserSecrets(owner, { text: 'REVOKE_PERSONAL=import-rotation', masked: true, onConflict: 'replace' }, {})
    assert.deepEqual(await stopped(fourth), { stopped: true, expired: true })
    const fifth = await consumer(owner)
    await personal.deleteUserSecret(owner, { id: row.id })
    assert.deepEqual(await stopped(fifth), { stopped: true, expired: true })
    assert.equal((await stopped(foreign)).stopped, false)
    assert.equal((await stopped(queued)).stopped, false)
  })
})
