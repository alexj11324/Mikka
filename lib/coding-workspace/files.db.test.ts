import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Pool } from 'pg'
import { runAssignmentSchema } from '@mikka/protocol'
import { remoteKey } from '@mikka/protocol/repository'
import { CodingWorkspaceError, WORKSPACE_MAX_FILE_BYTES, type WorkspaceReadCommand, type WorkspaceReadRequest,
  type WorkspaceReadReceipt, type WorkspaceReadResult } from '@mikka/protocol/coding-workspace'
import { readWorkspaceReceipt } from '../../packages/daemon/src/coding-workspace/files'
import type { JournalEntry } from '../../packages/daemon/src/runs/journal'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { disposableDatabase, E2E_DB_RULE } from '../../tests/helpers/e2e-target.mjs'
import { createTestDatabase, dropTestDatabase } from '../../tests/support/drop-test-database'

const url = process.env.E2E_DATABASE_URL
if (url) assert.ok(disposableDatabase(process.env, url), E2E_DB_RULE)
else if (process.env.REQUIRE_DB === '1') assert.fail('REQUIRE_DB=1 needs an isolated E2E_DATABASE_URL')
const execute = promisify(execFile)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const errorCode = (code: string) => (error: unknown) => error instanceof CodingWorkspaceError && error.code === code

test('coding workspace: real PostgreSQL authority, push delivery and daemon source references', { skip: !url, timeout: 180_000 }, async t => {
  const admin = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 })
  const database = `coding_workspace_${randomUUID().replaceAll('-', '')}_e2e`
  const version = Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num)
  assert.ok(version >= 170000 && version < 180000, 'coding workspace acceptance requires PostgreSQL 17')
  await createTestDatabase(admin, database, 'template0')
  const target = new URL(url!); target.pathname = `/${database}`
  const pool = new Pool({ connectionString: target.toString(), max: 8, connectionTimeoutMillis: 5000 })
  const root = await mkdtemp(join(tmpdir(), 'mikka-workspace-db-'))
  const names = ['MIKKA_DATABASE_URL', 'DATABASE_URL', 'ORVILO_DATABASE_URL', 'E2E_DATABASE_URL', 'BETTER_AUTH_SECRET', 'BETTER_AUTH_URL', 'WORKSPACE_SECRETS_KEY'] as const
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]))
  Object.assign(process.env, { MIKKA_DATABASE_URL: target.toString(), DATABASE_URL: target.toString(), ORVILO_DATABASE_URL: target.toString(), E2E_DATABASE_URL: target.toString(),
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'), BETTER_AUTH_URL: 'http://127.0.0.1:3199', WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex') })
  let appPool: Pool | undefined, workspacePool: Pool | undefined
  try {
    const directory = new URL('../../drizzle/', import.meta.url)
    for (const name of orderMigrations((await readdir(directory)).filter(name => name.endsWith('.sql'))))
      await pool.query(await readFile(new URL(name, directory), 'utf8'))
    // Supply Next's request context without replacing API authentication.
    const next = await import('next/server')
    mock.module('next/server', { namedExports: { ...next, after() {} } })
    mock.module('next/headers', { namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set() {}, delete() {} }) } })
    mock.module('next-intl/server', { namedExports: { getLocale: async () => 'en', getTranslations: async () => Object.assign((code: string) => code, { has: () => true }) } })
    // Only external gateway delivery is replaced. SQL, LISTEN/NOTIFY, source
    // authority, secret masking and the daemon filesystem handler stay real.
    const wakes: string[] = [], wakeBarriers = new Map<string, Promise<void>>()
    const gateway = await import('../device-gateway-notify')
    mock.module('../device-gateway-notify', { namedExports: { ...gateway, wakeDeviceWorkNow: async (deviceId: string) => {
      wakes.push(deviceId); await wakeBarriers.get(deviceId)
    } } })
    const { resolveRunWorktree } = await import('./identity')
    const { requestWorkspaceRead, pendingWorkspaceReads, finishWorkspaceRead, workspaceResultMaskPolicy,
      copyWorkspaceResultMaskPolicy, assertWorkspaceResultMaskPolicy } = await import('./requests')
    const { withWorkspaceAuthority } = await import('./authority')
    const { validateWorkspaceReceipt } = await import('./receipt')
    const { secretMaskerFor } = await import('../secrets/runtime')
    const { maskDeep } = await import('../secrets/mask')
    const { createFileMention, resolveFileMentions } = await import('./mentions')
    const { submitFileMentions } = await import('./submit')
    const { ActionFailureError } = await import('../action-error')
    const { subscribeShared, DEVICE_WORK_CHANNEL, notifyChannel } = await import('../db/listen')
    appPool = (await import('../db')).pool; workspacePool = (await import('../workspace-db')).workspacePool
    const owner = `workspace-owner-${randomUUID()}`, member = `workspace-member-${randomUUID()}`, stranger = `workspace-stranger-${randomUUID()}`
    for (const user of [owner, member, stranger]) await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())', [user, `${user}@example.invalid`])
    const workspaceId = randomUUID(), otherWorkspace = randomUUID()
    for (const id of [workspaceId, otherWorkspace]) {
      await pool.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,\'Coding workspace fixture\')', [id, owner])
      for (const user of [owner, member]) await pool.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,\'member\',\'active\')', [id, user, `${user}@example.invalid`])
    }
    const actor = { userId: owner, workspaceId }
    async function fixture(cloud = false, tenant: string = workspaceId) {
      const runId = randomUUID(), repoId = randomUUID(), deviceId = randomUUID(), tokenId = randomUUID(), agentId = randomUUID()
      const worktree = join(root, runId), remote = `https://github.com/mikka-fixtures/${runId}.git`, repositoryKey = remoteKey(remote)
      await mkdir(join(worktree, 'src'), { recursive: true })
      await writeFile(join(worktree, 'src/example.ts'), 'export const answer = 42\nexport const label = "fixture"\n')
      await writeFile(join(worktree, 'README.md'), '# Synthetic fixture\n')
      await execute('git', ['init', '--initial-branch=main', worktree])
      await execute('git', ['-C', worktree, 'remote', 'add', 'origin', remote])
      await execute('git', ['-C', worktree, 'add', '.'])
      await execute('git', ['-C', worktree, '-c', 'user.name=Mikka fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Synthetic workspace fixture'])
      const head = (await execute('git', ['-C', worktree, 'rev-parse', 'HEAD'])).stdout.trim()
      await pool.query('INSERT INTO devices(id,"ownerId",name,kind) VALUES($1,$2,\'Coding workspace fixture\',$3)', [deviceId, owner, cloud ? 'cloud' : 'local'])
      await pool.query('INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,$3,\'codex\',$4)', [agentId, owner, `Fixture ${runId}`, deviceId])
      await pool.query('INSERT INTO device_repos(id,"userId","deviceId","repoPath","remoteUrl") VALUES($1,$2,$3,$4,$5)', [repoId, owner, deviceId, repositoryKey, remote])
      await pool.query('INSERT INTO device_tokens(id,"userId","tokenHash","boundDeviceId","boundWorkspaceId","expiresAt") VALUES($1,$2,$3,$4,$5,now()+interval \'1 hour\')', [tokenId, owner, hash(randomUUID()), deviceId, tenant])
      const definition = { executionIdentity: { workspaceId: tenant }, repositoryAdmission: { workspaceId: tenant, remoteKey: repositoryKey } }
      await pool.query(`INSERT INTO agent_runs(id,"userId","agentId","deviceId","deviceRepoId","deviceTokenId",status,"worktreePath","leaseExpiresAt","agentDefinition")
        VALUES($1,$2,$3,$4,$5,$6,'running',$7,now()+interval '10 minutes',$8)`, [runId, owner, agentId, deviceId, repoId, tokenId, worktree, definition])
      if (cloud) await pool.query(`INSERT INTO thread_machines("runId","workspaceId","ownerId","sandboxId","snapshotId","operationId",state,"deviceId",epoch)
        VALUES($1,$2,$3,$4,'synthetic-snapshot',$5,'running',$6,1)`, [runId, tenant, owner, `synthetic-${runId}`, randomUUID(), deviceId])
      const entry: JournalEntry = { assignment: runAssignmentSchema.parse({ runId, issueId: randomUUID(), repoId, deviceId, remoteUrl: remote, baseBranch: 'main', harness: 'codex', prompt: 'Read synthetic fixture', kind: 'implement', leaseExpiresAt: new Date(Date.now() + 600_000).toISOString() }),
        state: 'running', sessionId: null, worktree, baseCommit: head, lastSeq: 0, error: null, updatedAt: new Date().toISOString() }
      return { runId, repoId, deviceId, tokenId, worktree, repositoryKey, entry, caller: { userId: owner, tokenId } }
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>
    const resolve = (f: Fixture, who: { userId: string; workspaceId: string } = actor) => resolveRunWorktree(pool, pool, who, f.runId, f.repoId)
    async function queue(f: Fixture, request: WorkspaceReadRequest, ttl = 60_000) {
      const { identity } = await resolve(f), id = randomUUID(), expiresAt = new Date(Date.now() + ttl)
      await pool.query(`INSERT INTO coding_workspace_requests(id,"ownerId","workspaceId","runId","repoId","deviceId","tokenId",identity,request,"expiresAt")
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, owner, workspaceId, f.runId, f.repoId, f.deviceId, f.tokenId, identity, request, expiresAt])
      return { id, identity, request, expiresAt: expiresAt.toISOString() }
    }
    async function exchange<T>(f: Fixture, start: (signal: AbortSignal) => Promise<T>, beforeReceipt?: () => Promise<void>) {
      const subscription = await subscribeShared(pool, DEVICE_WORK_CHANNEL, [f.deviceId])
      assert.ok(subscription, 'a real direct PostgreSQL LISTEN session is required')
      const controller = new AbortController()
      const outcome = start(controller.signal).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
      try {
        assert.equal(await subscription.next(5000), 'notified', 'queue insertion wakes the daemon without SQL polling')
        const commands = await pendingWorkspaceReads(pool, pool, f.caller, f.deviceId)
        assert.equal(commands.length, 1)
        const command = commands[0]!
        const receipt = await readWorkspaceReceipt(command, f.entry)
        await beforeReceipt?.()
        assert.equal(await finishWorkspaceRead(pool, pool, f.caller, f.deviceId, command.id, receipt), true)
        const result = await outcome
        if (!result.ok) throw result.error
        assert.equal((await pool.query('SELECT 1 FROM coding_workspace_requests WHERE id=$1', [command.id])).rowCount, 0, 'source receipt is consumed and deleted')
        assert.ok(wakes.includes(f.deviceId), 'the push wake is sent while the HTTP request waits')
        return { value: result.value, command, receipt }
      } finally { controller.abort(); subscription.close(); await outcome }
    }
    async function registerOwnerSecret(value: string) {
      const { sealSecret, userSecretAad } = await import('../secrets/crypto')
      const row = { id: randomUUID(), userId: owner, name: `CODING_WORKSPACE_POLICY_${randomUUID().replaceAll('-', '').toUpperCase()}`, kind: 'secret' }
      const sealed = sealSecret(value, userSecretAad(row))
      await pool.query('INSERT INTO user_secrets(id,"userId",name,kind,ciphertext,iv,"keyVersion") VALUES($1,$2,$3,$4,$5,$6,$7)',
        [row.id, row.userId, row.name, row.kind, sealed.ciphertext, sealed.iv, sealed.keyVersion])
      return row.id
    }
    /** Hold only the external wake completion. The request, receipt validation,
     * encrypted secret write and consumption all use their real PG paths. */
    async function afterStoredRead<T>(f: Fixture, start: (signal: AbortSignal) => Promise<T>, afterStored:
      (command: WorkspaceReadCommand, receipt: WorkspaceReadReceipt, stored: { result: WorkspaceReadResult; maskPolicy: string | null }) => Promise<void>) {
      const subscription = await subscribeShared(pool, DEVICE_WORK_CHANNEL, [f.deviceId])
      assert.ok(subscription)
      const barrier = Promise.withResolvers<void>(), controller = new AbortController()
      wakeBarriers.set(f.deviceId, barrier.promise)
      const outcome = start(controller.signal).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
      try {
        assert.equal(await subscription.next(5000), 'notified', 'real queue commit is observed without polling')
        const commands = await pendingWorkspaceReads(pool, pool, f.caller, f.deviceId)
        assert.equal(commands.length, 1)
        const command = commands[0]!, receipt = await readWorkspaceReceipt(command, f.entry)
        assert.equal(await finishWorkspaceRead(pool, pool, f.caller, f.deviceId, command.id, receipt), true)
        const stored = (await pool.query<{ result: WorkspaceReadResult; maskPolicy: string | null }>(
          'SELECT result,"maskPolicy" FROM coding_workspace_requests WHERE id=$1', [command.id])).rows[0]
        assert.ok(stored?.result.ok, 'the complete real source proof was accepted before the policy change')
        assert.match(stored.maskPolicy ?? '', /^[a-f0-9]{64}$/)
        assert.equal(stored.maskPolicy, (await secretMaskerFor({ workspaceId, ownerId: owner })).sourcePolicy)
        assert.equal('maskPolicy' in stored.result, false, 'the policy is private database metadata')
        await afterStored(command, receipt, stored)
        barrier.resolve()
        const result = await outcome
        assert.equal((await pool.query('SELECT 1 FROM coding_workspace_requests WHERE id=$1', [command.id])).rowCount, 0)
        if (!result.ok) throw result.error
        return result.value
      } finally {
        barrier.resolve(); wakeBarriers.delete(f.deviceId); controller.abort(); subscription.close(); await outcome
      }
    }
    async function submissionFixture(cloud = false) {
      const f = await fixture(cloud)
      // A task-less legacy Run has frozen execution scope, but no admission
      // receipt. A partial synthetic receipt must not bypass normal admission.
      await pool.query('UPDATE agent_runs SET "agentDefinition"="agentDefinition"-\'repositoryAdmission\' WHERE id=$1', [f.runId])
      const { auth } = await import('../auth')
      const session = await (await auth.$context).internalAdapter.createSession(owner)
      assert.ok(session)
      const { value: mention } = await exchange(f, signal => createFileMention(pool, pool, actor, f.runId, f.repoId,
        { kind: 'file', path: 'src/example.ts', range: { startLine: 1, endLine: 1 } }, signal))
      const { value: resolved } = await exchange(f, signal => resolveFileMentions(pool, pool, actor, f.runId, f.repoId, [mention.id], signal))
      return { f, session, resolved, submitActor: { ...actor, sessionId: session.id } }
    }
    async function factorySubmissionFixture() {
      const base = await submissionFixture()
      const issueId = randomUUID(), teamId = randomUUID(), taskId = randomUUID(), attemptId = randomUUID(), sourceEventId = randomUUID()
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('INSERT INTO mikka_teams(id,"workspaceId","userId",name,identifier) VALUES($1,$2,$3,\'Factory context fixture\',$4)',
          [teamId, workspaceId, owner, `F${randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase()}`])
        await client.query('INSERT INTO mikka_team_members("teamId","userId",role) VALUES($1,$2,\'owner\')', [teamId, owner])
        await client.query(`INSERT INTO issues(id,"userId","workspaceId",title,content,status,priority,scope)
          VALUES($1,$2,$3,'Factory context fixture','{"type":"doc","content":[]}','doing','normal','workspace')`, [issueId, owner, workspaceId])
        await client.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)', [issueId, teamId, workspaceId, owner])
        await client.query('UPDATE agent_runs SET "issueId"=$2 WHERE id=$1', [base.f.runId, issueId])
        await client.query(`INSERT INTO coordinator_events(id,"userId","issueId",kind,"dedupeKey",payload)
          VALUES($1::uuid,$2,$3,'user_message',$1::text,$4)`, [sourceEventId, owner, issueId, { text: 'Implement the synthetic Factory task' }])
        // The task/attempt pair uses the production deferred foreign key,
        // matching the existing Factory database fixtures.
        await client.query(`INSERT INTO factory_tasks(id,"userId","issueId","sourceEventId",route,stage,status,revision,"attemptId",reason)
          VALUES($1,$2,$3,$4,$5,'execute','running',7,$6,'Synthetic active Factory context')`,
        [taskId, owner, issueId, sourceEventId, { issueId, sourceEventId, eventId: randomUUID(), rationale: 'Owner request', missingInformation: [], missingPermissions: [], needsSpec: false }, attemptId])
        await client.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"runId",reason,output)
          VALUES($1,$2,'execute',1,1,'running',$3,'Synthetic active attempt',$4)`, [attemptId, taskId, base.f.runId, { requestEpoch: sourceEventId }])
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
      base.f.entry.assignment.issueId = issueId
      const { value: resolved } = await exchange(base.f, signal => resolveFileMentions(pool, pool, actor, base.f.runId, base.f.repoId, base.resolved.ids, signal))
      const snapshot = async () => ({
        task: (await pool.query('SELECT * FROM factory_tasks WHERE id=$1', [taskId])).rows[0],
        attempts: (await pool.query('SELECT * FROM factory_attempts WHERE "taskId"=$1 ORDER BY position', [taskId])).rows,
        events: (await pool.query('SELECT * FROM factory_events WHERE "taskId"=$1 ORDER BY "eventId"', [taskId])).rows,
        sources: (await pool.query('SELECT * FROM coordinator_events WHERE "userId"=$1 AND "issueId"=$2 ORDER BY id', [owner, issueId])).rows,
      })
      return { ...base, resolved, issueId, taskId, attemptId, sourceEventId, snapshot }
    }

    await t.test('owner reads the exact same Run Git worktree through queue, NOTIFY, daemon and receipt', async () => {
      const f = await fixture()
      const { value } = await exchange(f, signal => requestWorkspaceRead(pool, pool, actor, f.runId, f.repoId, { kind: 'file', path: 'src/example.ts', range: { startLine: 1, endLine: 1 } }, signal))
      assert.ok(value.ok && value.kind === 'file')
      assert.equal(value.content, 'export const answer = 42')
      assert.equal(value.revision.headSha, f.entry.baseCommit)
      assert.equal(value.identity.runId, f.runId)
      assert.equal(value.identity.repositoryKey, f.repositoryKey)
      assert.equal(value.availability, 'online')
      assert.equal(value.editable, false)
    })

    await t.test('files GET accepts real session/PAT authority and rejects missing, revoked, tenant and member credentials', async () => {
      const f = await fixture()
      const { auth } = await import('../auth')
      const { createLegacyPersonalAccessToken } = await import('../tokens/store')
      const { GET } = await import('../../app/api/runs/[runId]/workspace/files/route')
      const session = await (await auth.$context).internalAdapter.createSession(owner)
      assert.ok(session)
      const ownerToken = await createLegacyPersonalAccessToken(owner, workspaceId, { name: 'Workspace fixture owner' })
      const memberToken = await createLegacyPersonalAccessToken(member, workspaceId, { name: 'Workspace fixture member' })
      const otherToken = await createLegacyPersonalAccessToken(owner, otherWorkspace, { name: 'Workspace fixture other tenant' })
      const endpoint = `http://127.0.0.1:3199/api/runs/${f.runId}/workspace/files?repoId=${f.repoId}&workspaceId=${workspaceId}&kind=file&path=src%2Fexample.ts`
      const get = (credential?: string, signal?: AbortSignal) => GET(new Request(endpoint, { headers: credential ? { authorization: `Bearer ${credential}` } : {}, signal }), { params: Promise.resolve({ runId: f.runId }) })
      // Both credentials use their real database verifiers. A session bearer
      // is Better Auth's supported transport for an existing stored session.
      for (const credential of [session.token, ownerToken.token]) {
        const { value: response } = await exchange(f, signal => get(credential, signal))
        assert.equal(response.status, 200)
        assert.equal(response.headers.get('cache-control'), 'private, no-store')
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
        const body = await response.json()
        assert.equal(body.identity.runId, f.runId)
        assert.equal(body.content, 'export const answer = 42\nexport const label = "fixture"\n')
      }
      assert.equal((await get()).status, 401)
      assert.equal((await get(memberToken.token)).status, 404)
      assert.equal((await get(otherToken.token)).status, 404)
      const { value: revokedPat } = await exchange(f, signal => get(ownerToken.token, signal), async () => {
        await pool.query('UPDATE personal_access_tokens SET "revokedAt"=now() WHERE id=$1', [ownerToken.id])
      })
      assert.equal(revokedPat.status, 401, 'PAT revocation during the device read is rechecked before response')
      assert.deepEqual(await revokedPat.json(), { ok: false, code: 'authRequired' })
      assert.equal((await get(ownerToken.token)).status, 401)
      const { value: revokedSession } = await exchange(f, signal => get(session.token, signal), async () => {
        await (await auth.$context).internalAdapter.deleteSession(session.token)
      })
      assert.equal(revokedSession.status, 401, 'session revocation during the device read is rechecked before response')
      assert.deepEqual(await revokedSession.json(), { ok: false, code: 'authRequired' })
      assert.equal((await get(session.token)).status, 401)
      assert.equal((await pool.query('SELECT 1 FROM coding_workspace_requests WHERE "runId"=$1', [f.runId])).rowCount, 0)
    })

    await t.test('shared membership grants neither another owner\'s device nor another tenant\'s Run', async () => {
      const f = await fixture()
      for (const who of [{ userId: member, workspaceId }, { userId: stranger, workspaceId }, { userId: owner, workspaceId: otherWorkspace }])
        await assert.rejects(() => resolve(f, who), errorCode('workspace_not_found'))
      await assert.rejects(() => resolveRunWorktree(pool, pool, actor, f.runId, randomUUID()), errorCode('workspace_not_found'))
      await assert.rejects(() => resolveRunWorktree(pool, pool, actor, randomUUID(), f.repoId), errorCode('workspace_not_found'))
    })

    await t.test('current task ACL rejects deletion, moved workspace and removed team links despite a valid frozen machine', async () => {
      const f = await fixture(), issueId = randomUUID(), teamId = randomUUID(), otherTeam = randomUUID()
      for (const [id, workspace] of [[teamId, workspaceId], [otherTeam, otherWorkspace]]) {
        await pool.query('INSERT INTO mikka_teams(id,"workspaceId","userId",name,identifier) VALUES($1,$2,$3,\'Workspace task fixture\',$4)', [id, workspace, owner, `W${randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase()}`])
        await pool.query('INSERT INTO mikka_team_members("teamId","userId",role) VALUES($1,$2,\'owner\')', [id, owner])
      }
      await pool.query(`INSERT INTO issues(id,"userId","workspaceId",title,content,status,priority,scope) VALUES($1,$2,$3,'Workspace task fixture','{"type":"doc","content":[]}','doing','normal','workspace')`, [issueId, owner, workspaceId])
      await pool.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)', [issueId, teamId, workspaceId, owner])
      await pool.query('UPDATE agent_runs SET "issueId"=$2 WHERE id=$1', [f.runId, issueId])
      assert.equal((await resolve(f)).identity.workspaceId, workspaceId)
      const command = await queue(f, { kind: 'file', path: 'README.md' })
      const receipt = await readWorkspaceReceipt(command, f.entry)
      const definition = (await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [f.runId])).rows[0].agentDefinition
      await pool.query('UPDATE agent_runs SET "agentDefinition"=\'{}\' WHERE id=$1', [f.runId])
      await pool.query('UPDATE device_tokens SET "boundWorkspaceId"=NULL WHERE id=$1', [f.tokenId])
      await assert.rejects(() => resolve(f), errorCode('workspace_not_found'), 'a current task link cannot invent frozen checkout authority')
      assert.deepEqual(await pendingWorkspaceReads(pool, pool, f.caller, f.deviceId), [])
      await assert.rejects(() => finishWorkspaceRead(pool, pool, f.caller, f.deviceId, command.id, receipt), errorCode('workspace_not_found'))
      assert.equal((await pool.query('SELECT result FROM coding_workspace_requests WHERE id=$1', [command.id])).rows[0].result, null)
      await pool.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [f.runId, definition])
      await pool.query('UPDATE device_tokens SET "boundWorkspaceId"=$2 WHERE id=$1', [f.tokenId, workspaceId])
      await pool.query('UPDATE issues SET content=$2 WHERE id=$1', [issueId, { type: 'doc', attrs: { mikka: { deletedAt: new Date().toISOString() } }, content: [] }])
      await assert.rejects(() => resolve(f), errorCode('workspace_not_found'))
      assert.deepEqual(await pendingWorkspaceReads(pool, pool, f.caller, f.deviceId), [])
      await assert.rejects(() => finishWorkspaceRead(pool, pool, f.caller, f.deviceId, command.id, receipt), errorCode('workspace_not_found'))
      assert.equal((await pool.query('SELECT result FROM coding_workspace_requests WHERE id=$1', [command.id])).rows[0].result, null)
      await pool.query('UPDATE issues SET content=\'{"type":"doc","content":[]}\' WHERE id=$1', [issueId])
      await pool.query('UPDATE mikka_team_issues SET "teamId"=$2,"workspaceId"=$3 WHERE "issueId"=$1', [issueId, otherTeam, otherWorkspace])
      await assert.rejects(() => resolve(f), errorCode('workspace_not_found'))
      await pool.query('DELETE FROM mikka_team_issues WHERE "issueId"=$1', [issueId])
      // A bound workspace Task needs no Team link under the current scope
      // policy; the frozen machine and current membership still authorize it.
      assert.equal((await resolve(f)).identity.workspaceId, workspaceId)
      await pool.query('DELETE FROM coding_workspace_requests WHERE id=$1', [command.id])
      // Hard deletion cascades the Run too; an old id never resolves to a
      // historical checkpoint presented as a live checkout.
      await pool.query('DELETE FROM issues WHERE id=$1', [issueId])
      await assert.rejects(() => resolve(f), errorCode('workspace_not_found'))
    })

    await t.test('a no-team task belongs only to its owner\'s personal workspace; null-task legacy Runs retain their frozen authority', async () => {
      const f = await fixture(), issueId = randomUUID()
      assert.equal((await resolve(f)).identity.workspaceId, workspaceId, 'a genuinely task-less historical Run remains supported')
      let personalId = (await pool.query('SELECT id FROM mikka_workspaces WHERE "userId"=$1 AND kind=\'personal\'', [owner])).rows[0]?.id as string | undefined
      if (!personalId) {
        personalId = randomUUID()
        await pool.query('INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES($1,$2,\'Personal task fixture\',\'personal\')', [personalId, owner])
        await pool.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,\'admin\',\'active\')', [personalId, owner, `${owner}@example.invalid`])
      }
      await pool.query(`INSERT INTO issues(id,"userId","workspaceId",title,content,status,priority,scope) VALUES($1,$2,$3,'No-team task fixture','{"type":"doc"}','doing','normal','personal')`, [issueId, owner, personalId])
      // A Run's frozen tenant is part of its identity; the database refuses to
      // re-bind the team Run to the personal Task before the resolver runs.
      await assert.rejects(() => pool.query('UPDATE agent_runs SET "issueId"=$2 WHERE id=$1', [f.runId, issueId]),
        (error: unknown) => (error as { code?: string }).code === '23514')
      // A Run created in the personal workspace resolves the personal Task.
      const personalRun = await fixture(false, personalId)
      const personalActor = { userId: owner, workspaceId: personalId }
      assert.equal((await resolve(personalRun, personalActor)).identity.workspaceId, personalId)
      // The existing domain rejects promotion without an authorized Team.
      // Seed a separate historical row to test legacy reads; do not disable
      // the production promotion guard to manufacture this state.
      await assert.rejects(() => pool.query('UPDATE issues SET scope=\'workspace\' WHERE id=$1', [issueId]),
        (error: unknown) => (error as { code?: string }).code === '23514')
      const legacyIssueId = randomUUID()
      await pool.query(`INSERT INTO issues(id,"userId","workspaceId",title,content,status,priority,scope)
        VALUES($1,$2,$3,'Unlinked legacy task fixture','{"type":"doc"}','doing','normal','workspace')`, [legacyIssueId, owner, personalId])
      await pool.query('UPDATE agent_runs SET "issueId"=$2 WHERE id=$1', [personalRun.runId, legacyIssueId])
      assert.equal((await resolve(personalRun, personalActor)).identity.workspaceId, personalId)
      await pool.query('UPDATE issues SET "userId"=$2,scope=\'personal\' WHERE id=$1', [legacyIssueId, member])
      // The owner remains an admin of their personal workspace; another user
      // who is not a member cannot resolve the legacy task.
      assert.equal((await resolve(personalRun, personalActor)).identity.workspaceId, personalId)
      await assert.rejects(() => resolve(personalRun, { userId: member, workspaceId: personalId }), errorCode('workspace_not_found'))
    })

    await t.test('every nonempty frozen workspace source must agree; repository substitution fails closed', async () => {
      const f = await fixture(true)
      const changes = [
        ['UPDATE device_tokens SET "boundWorkspaceId"=$2 WHERE id=$1', f.tokenId],
        ['UPDATE thread_machines SET "workspaceId"=$2 WHERE "runId"=$1', f.runId],
        ["UPDATE agent_runs SET \"agentDefinition\"=jsonb_set(\"agentDefinition\",'{repositoryAdmission,workspaceId}',to_jsonb($2::text)) WHERE id=$1", f.runId],
      ] as const
      for (const [sql, id] of changes) {
        await pool.query(sql, [id, otherWorkspace])
        await assert.rejects(() => resolve(f), errorCode('workspace_not_found'))
        await pool.query(sql, [id, workspaceId])
      }
      await pool.query('UPDATE device_repos SET "remoteUrl"=\'https://github.com/mikka-fixtures/substituted.git\' WHERE id=$1', [f.repoId])
      await assert.rejects(() => resolve(f), errorCode('workspace_not_found'))
    })

    await t.test('membership suspension, token revocation and expiry revoke an existing request', async () => {
      const f = await fixture(), command = await queue(f, { kind: 'file', path: 'README.md' })
      const receipt = await readWorkspaceReceipt(command, f.entry)
      for (const [block, restore, id] of [
        ['UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', 'UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', workspaceId],
        ['UPDATE device_tokens SET "revokedAt"=now() WHERE id=$1', 'UPDATE device_tokens SET "revokedAt"=NULL WHERE id=$1', f.tokenId],
        ['UPDATE device_tokens SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1', 'UPDATE device_tokens SET "expiresAt"=now()+interval \'1 hour\' WHERE id=$1', f.tokenId],
      ]) {
        const args = id === workspaceId ? [id, owner] : [id]
        await pool.query(block!, args)
        try {
          assert.deepEqual(await pendingWorkspaceReads(pool, pool, f.caller, f.deviceId), [])
          await assert.rejects(() => finishWorkspaceRead(pool, pool, f.caller, f.deviceId, command.id, receipt), errorCode('workspace_not_found'))
          assert.equal((await pool.query('SELECT result FROM coding_workspace_requests WHERE id=$1', [command.id])).rows[0].result, null)
        } finally { await pool.query(restore!, args) }
      }
      await pool.query('DELETE FROM coding_workspace_requests WHERE id=$1', [command.id])
    })

    await t.test('stop and lease loss deny live access; replacing a VM epoch fences old receipts', async () => {
      const f = await fixture(true), command = await queue(f, { kind: 'file', path: 'README.md' })
      const receipt = await readWorkspaceReceipt(command, f.entry)
      await pool.query('UPDATE agent_runs SET "leaseExpiresAt"=now()-interval \'1 second\' WHERE id=$1', [f.runId])
      await assert.rejects(() => resolve(f), errorCode('workspace_machine_unavailable'))
      await pool.query('UPDATE agent_runs SET "leaseExpiresAt"=now()+interval \'10 minutes\',"stopRequestedAt"=now() WHERE id=$1', [f.runId])
      await assert.rejects(() => resolve(f), errorCode('workspace_machine_unavailable'))
      await pool.query('UPDATE agent_runs SET "stopRequestedAt"=NULL WHERE id=$1', [f.runId])
      await pool.query('UPDATE thread_machines SET epoch=epoch+1 WHERE "runId"=$1', [f.runId])
      assert.notEqual((await resolve(f)).identity.bindingId, command.identity.bindingId)
      assert.deepEqual(await pendingWorkspaceReads(pool, pool, f.caller, f.deviceId), [])
      assert.equal(await finishWorkspaceRead(pool, pool, f.caller, f.deviceId, command.id, receipt), false)
      await pool.query('UPDATE thread_machines SET state=\'ended\' WHERE "runId"=$1', [f.runId])
      await assert.rejects(() => resolve(f), errorCode('workspace_machine_unavailable'))
      await pool.query('DELETE FROM coding_workspace_requests WHERE id=$1', [command.id])
    })

    await t.test('wrong caller, device, token, expired request and replay never persist source', async () => {
      const f = await fixture(), command = await queue(f, { kind: 'file', path: 'README.md' })
      const receipt = await readWorkspaceReceipt(command, f.entry)
      for (const [caller, deviceId] of [[{ ...f.caller, userId: member }, f.deviceId], [{ ...f.caller, tokenId: randomUUID() }, f.deviceId], [f.caller, randomUUID()]] as const) {
        assert.deepEqual(await pendingWorkspaceReads(pool, pool, caller, deviceId), [])
        assert.equal(await finishWorkspaceRead(pool, pool, caller, deviceId, command.id, receipt), false)
      }
      assert.deepEqual(await pendingWorkspaceReads(pool, pool, f.caller, f.deviceId, [command.id]), [])
      await pool.query('UPDATE coding_workspace_requests SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1', [command.id])
      assert.deepEqual(await pendingWorkspaceReads(pool, pool, f.caller, f.deviceId), [])
      assert.equal(await finishWorkspaceRead(pool, pool, f.caller, f.deviceId, command.id, receipt), false)
      await pool.query('UPDATE coding_workspace_requests SET "expiresAt"=now()+interval \'1 minute\' WHERE id=$1', [command.id])
      assert.equal(await finishWorkspaceRead(pool, pool, f.caller, f.deviceId, command.id, receipt), true)
      assert.equal(await finishWorkspaceRead(pool, pool, f.caller, f.deviceId, command.id, receipt), false)
      await pool.query('DELETE FROM coding_workspace_requests WHERE id=$1', [command.id])
    })

    await t.test('owner request quota is atomic and abandoned requests release their source receipt', async () => {
      const f = await fixture()
      const queued = await Promise.all(Array.from({ length: 8 }, () => queue(f, { kind: 'file', path: 'README.md' })))
      try {
        await assert.rejects(() => requestWorkspaceRead(pool, pool, actor, f.runId, f.repoId, { kind: 'file', path: 'README.md' }), errorCode('workspace_limit_exceeded'))
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM coding_workspace_requests WHERE "runId"=$1', [f.runId])).rows[0].n, 8)
      } finally { await pool.query('DELETE FROM coding_workspace_requests WHERE id=ANY($1::uuid[])', [queued.map(item => item.id)]) }
      const subscription = await subscribeShared(pool, DEVICE_WORK_CHANNEL, [f.deviceId])
      assert.ok(subscription)
      const controller = new AbortController()
      const waiting = requestWorkspaceRead(pool, pool, actor, f.runId, f.repoId, { kind: 'file', path: 'README.md' }, controller.signal)
      const rejected = assert.rejects(waiting, errorCode('workspace_machine_unavailable'))
      try {
        assert.equal(await subscription.next(5000), 'notified')
        controller.abort()
        await rejected
        assert.equal((await pool.query('SELECT 1 FROM coding_workspace_requests WHERE "runId"=$1', [f.runId])).rowCount, 0)
      } finally { controller.abort(); subscription.close(); await rejected }
    })

    await t.test('wrong kind, path, range and nested cross-Run identity are rejected before storage', async () => {
      const f = await fixture(), command = await queue(f, { kind: 'file', path: 'src/example.ts', range: { startLine: 1, endLine: 1 } })
      const receipt = await readWorkspaceReceipt(command, f.entry)
      const result = receipt.result
      assert.ok(result.ok && result.kind === 'file')
      const wrongKind = await readWorkspaceReceipt({ ...command, request: { kind: 'tree', path: '', limit: 100 } }, f.entry)
      const invalid: WorkspaceReadReceipt[] = [wrongKind,
        { ...receipt, result: { ...result, path: 'README.md' } },
        { ...receipt, result: { ...result, startLine: 2, endLine: 2 } },
        { ...receipt, result: { ...result, identity: { ...result.identity, runId: randomUUID() } } }]
      for (const response of invalid) assert.equal(await finishWorkspaceRead(pool, pool, f.caller, f.deviceId, command.id, response), false)
      assert.equal((await pool.query('SELECT result FROM coding_workspace_requests WHERE id=$1', [command.id])).rows[0].result, null)
      await pool.query('DELETE FROM coding_workspace_requests WHERE id=$1', [command.id])
      const context = await queue(f, { kind: 'context', selection: { kind: 'file', path: 'src/example.ts' } })
      const contextReceipt = await readWorkspaceReceipt(context, f.entry)
      assert.ok(contextReceipt.result.ok && contextReceipt.result.kind === 'context')
      const changed = { ...contextReceipt, result: { ...contextReceipt.result, files: contextReceipt.result.files.map(file => ({ ...file, identity: { ...file.identity, runId: randomUUID() } })) } }
      assert.equal(await finishWorkspaceRead(pool, pool, f.caller, f.deviceId, context.id, changed), false)
      assert.equal((await pool.query('SELECT result FROM coding_workspace_requests WHERE id=$1', [context.id])).rows[0].result, null)
      await pool.query('DELETE FROM coding_workspace_requests WHERE id=$1', [context.id])
    })

    await t.test('source proofs must be complete, unique and canonical and match every file byte, hash, size and range', async () => {
      const f = await fixture(), command = await queue(f, { kind: 'file', path: 'src/example.ts', range: { startLine: 1, endLine: 1 } })
      const receipt = await readWorkspaceReceipt(command, f.entry), result = receipt.result
      assert.ok(result.ok && result.kind === 'file')
      assert.equal(receipt.files.length, 1)
      const proof = receipt.files[0]!
      const invalid: Array<[string, WorkspaceReadReceipt]> = [
        ['missing envelope files', { result } as WorkspaceReadReceipt],
        ['missing whole source', { ...receipt, files: [] }],
        ['forged bytes', { ...receipt, files: [{ ...proof, base64: Buffer.from('forged source').toString('base64') }] }],
        ['another source path', { ...receipt, files: [{ ...proof, path: 'README.md' }] }],
        ['extra source', { ...receipt, files: [proof, { ...proof, path: 'README.md' }] }],
        ['duplicate source', { ...receipt, files: [proof, proof] }],
        ['wrong hash', { ...receipt, result: { ...result, contentSha256: '0'.repeat(64) } }],
        ['wrong byte size', { ...receipt, result: { ...result, size: result.size + 1 } }],
        ['forged selected text', { ...receipt, result: { ...result, content: 'export const answer = 99' } }],
        ['wrong total lines', { ...receipt, result: { ...result, totalLines: result.totalLines! + 1 } }],
        ['wrong truncation', { ...receipt, result: { ...result, truncated: !result.truncated } }],
      ]
      for (const [reason, malformed] of invalid) {
        assert.equal(await finishWorkspaceRead(pool, pool, f.caller, f.deviceId, command.id, malformed), false, reason)
        assert.equal((await pool.query('SELECT result FROM coding_workspace_requests WHERE id=$1', [command.id])).rows[0].result, null, reason)
      }
      assert.equal(await finishWorkspaceRead(pool, pool, f.caller, f.deviceId, command.id, receipt), true, 'the intact receipt remains admissible')
      const stored = (await pool.query('SELECT result FROM coding_workspace_requests WHERE id=$1', [command.id])).rows[0].result
      assert.deepEqual(stored, result, 'only the selected public result is persisted')
      assert.equal('base64' in stored || 'files' in stored, false)
      await pool.query('DELETE FROM coding_workspace_requests WHERE id=$1', [command.id])

      await writeFile(join(f.worktree, 'src/example.ts'), 'a')
      const padded = await queue(f, { kind: 'file', path: 'src/example.ts' })
      const canonical = await readWorkspaceReceipt(padded, f.entry)
      assert.ok(canonical.result.ok && canonical.result.kind === 'file')
      assert.equal(canonical.files[0]!.base64, 'YQ==')
      assert.equal(Buffer.from('YR==', 'base64').toString(), 'a', 'padding-bit changes decode to identical bytes')
      const noncanonical = { ...canonical, files: [{ path: 'src/example.ts', base64: 'YR==' }] }
      assert.equal(await finishWorkspaceRead(pool, pool, f.caller, f.deviceId, padded.id, noncanonical), false)
      assert.equal((await pool.query('SELECT result FROM coding_workspace_requests WHERE id=$1', [padded.id])).rows[0].result, null)
      assert.equal(await finishWorkspaceRead(pool, pool, f.caller, f.deviceId, padded.id, canonical), true)
      await pool.query('DELETE FROM coding_workspace_requests WHERE id=$1', [padded.id])
    })

    await t.test('aggregate full-source proof bytes are bounded even when each selected range is small', async () => {
      const f = await fixture(), paths = ['src/example.ts', 'src/second.ts']
      for (const path of paths) await writeFile(join(f.worktree, path), `small selected line\n${'x'.repeat(WORKSPACE_MAX_FILE_BYTES / 2)}`)
      const selection = paths.map(path => ({ path, range: { startLine: 1, endLine: 1 } }))
      const command = await queue(f, { kind: 'context', selection: { kind: 'resolved', files: selection } })
      const reads = await Promise.all(selection.map(file => readWorkspaceReceipt({ ...command, request: { kind: 'file', ...file } }, f.entry)))
      const files = reads.map(receipt => {
        assert.ok(receipt.result.ok && receipt.result.kind === 'file')
        assert.equal(receipt.result.content, 'small selected line')
        assert.ok(receipt.result.size <= WORKSPACE_MAX_FILE_BYTES)
        return receipt.result
      })
      const first = files[0]!
      const forged: WorkspaceReadReceipt = { result: { ok: true, kind: 'context', identity: first.identity, revision: first.revision,
        observedAt: first.observedAt, availability: 'online', files, omitted: 0 }, files: reads.flatMap(receipt => receipt.files) }
      assert.ok(forged.files.reduce((sum, file) => sum + Buffer.from(file.base64, 'base64').length, 0) > WORKSPACE_MAX_FILE_BYTES)
      assert.equal(await finishWorkspaceRead(pool, pool, f.caller, f.deviceId, command.id, forged), false)
      assert.equal((await pool.query('SELECT result FROM coding_workspace_requests WHERE id=$1', [command.id])).rows[0].result, null)
      const bounded = await readWorkspaceReceipt(command, f.entry)
      assert.deepEqual(bounded, { result: { ok: false, code: 'workspace_limit_exceeded' }, files: [] }, 'the real reader also enforces the whole-source aggregate budget')
      for (const path of paths) await writeFile(join(f.worktree, path), `small selected line\n${'x'.repeat(WORKSPACE_MAX_FILE_BYTES / 2 - 100)}`)
      const admissible = await readWorkspaceReceipt(command, f.entry)
      assert.ok(admissible.result.ok && admissible.result.kind === 'context')
      assert.equal(await finishWorkspaceRead(pool, pool, f.caller, f.deviceId, command.id, admissible), true, 'the same selected ranges fit when combined proof bytes are within budget')
      assert.deepEqual((await pool.query('SELECT result FROM coding_workspace_requests WHERE id=$1', [command.id])).rows[0].result, admissible.result)
      await pool.query('DELETE FROM coding_workspace_requests WHERE id=$1', [command.id])
    })

    await t.test('an encrypted registered multiline secret blocks every separate range and never becomes a mention', async () => {
      const f = await fixture(), secretLines = [`fixture-first-${randomUUID()}`, `fixture-second-${randomUUID()}`]
      const secret = secretLines.join('\n'), source = `public before\n${secret}\npublic after\n`
      const { sealSecret, userSecretAad } = await import('../secrets/crypto')
      const { secretMaskerFor } = await import('../secrets/runtime')
      const row = { id: randomUUID(), userId: owner, name: 'CODING_WORKSPACE_MULTILINE_FIXTURE', kind: 'secret' }
      const sealed = sealSecret(secret, userSecretAad(row))
      await pool.query('INSERT INTO user_secrets(id,"userId",name,kind,ciphertext,iv,"keyVersion") VALUES($1,$2,$3,$4,$5,$6,$7)',
        [row.id, row.userId, row.name, row.kind, sealed.ciphertext, sealed.iv, sealed.keyVersion])
      try {
        const mask = await secretMaskerFor({ workspaceId, ownerId: owner })
        assert.notEqual(mask(secret), secret, 'the real stored encrypted value is loaded and decrypted')
        for (const line of secretLines) assert.equal(mask(line), line, 'a single range does not itself contain the registered value')
        await writeFile(join(f.worktree, 'src/example.ts'), source)
        for (const line of [1, 2, 3, 4]) {
          const range = { startLine: line, endLine: line }
          const command = await queue(f, { kind: 'file', path: 'src/example.ts', range })
          const receipt = await readWorkspaceReceipt(command, f.entry)
          assert.ok(receipt.result.ok && receipt.result.kind === 'file')
          assert.equal(receipt.result.content, source.split('\n')[line - 1])
          assert.equal(Buffer.from(receipt.files[0]!.base64, 'base64').toString('utf8'), source)
          assert.equal(await finishWorkspaceRead(pool, pool, f.caller, f.deviceId, command.id, receipt), true, `range ${line} completes only with a denial`)
          const stored = (await pool.query('SELECT result FROM coding_workspace_requests WHERE id=$1', [command.id])).rows[0].result
          assert.deepEqual(stored, { ok: false, code: 'workspace_path_unavailable' })
          await pool.query('DELETE FROM coding_workspace_requests WHERE id=$1', [command.id])
        }
        for (const line of [2, 3]) await assert.rejects(() => exchange(f, signal => createFileMention(pool, pool, actor, f.runId, f.repoId,
          { kind: 'file', path: 'src/example.ts', range: { startLine: line, endLine: line } }, signal)), errorCode('workspace_path_unavailable'))
        assert.equal((await pool.query('SELECT 1 FROM coding_workspace_mentions WHERE "runId"=$1', [f.runId])).rowCount, 0)
      } finally { await pool.query('DELETE FROM user_secrets WHERE id=$1', [row.id]) }
    })

    await t.test('a real secret registered after receipt storage invalidates every successful result before the waiter can consume partial source', async () => {
      const f = await fixture(), secretLines = [`receipt-window-first-${randomUUID()}`, `receipt-window-second-${randomUUID()}`]
      const secret = secretLines.join('\n'), source = `public before\n${secret}\npublic after\n`
      await writeFile(join(f.worktree, 'src/example.ts'), source)
      const requests: WorkspaceReadRequest[] = [
        { kind: 'file', path: 'src/example.ts', range: { startLine: 2, endLine: 2 } },
        { kind: 'file', path: 'src/example.ts', range: { startLine: 3, endLine: 3 } },
        { kind: 'search', query: 'example', limit: 10 },
        { kind: 'context', selection: { kind: 'file', path: 'src/example.ts', range: { startLine: 2, endLine: 2 } } },
        { kind: 'tree', path: 'src', limit: 100 },
      ]
      for (const request of requests) {
        let secretId: string | undefined
        try {
          await assert.rejects(() => afterStoredRead(f,
            signal => requestWorkspaceRead(pool, pool, actor, f.runId, f.repoId, request, signal),
            async (command, receipt, stored) => {
              assert.deepEqual(stored.result, receipt.result)
              if (stored.result.ok && stored.result.kind === 'file') {
                assert.equal(stored.result.content, secretLines[request.kind === 'file' && request.range?.startLine === 3 ? 1 : 0])
                assert.equal(Buffer.from(receipt.files[0]!.base64, 'base64').toString('utf8'), source)
              }
              secretId = await registerOwnerSecret(secret)
              const freshMask = await secretMaskerFor({ workspaceId, ownerId: owner })
              assert.notEqual(freshMask.sourcePolicy, stored.maskPolicy)
              assert.notEqual(freshMask(secret), secret, 'the fresh masker loads the real encrypted multiline value')
              assert.deepEqual(maskDeep(stored.result, freshMask), stored.result, 'masking only the public fragments would still leak these separate ranges')
              if (request.kind === 'file' || request.kind === 'context') assert.deepEqual(validateWorkspaceReceipt(command.request, command.identity, receipt, freshMask),
                { ok: false, code: 'workspace_path_unavailable' }, 'rechecking the complete proof would refuse the new secret')
            }), errorCode('workspace_path_unavailable'))
          assert.equal((await pool.query('SELECT 1 FROM coding_workspace_requests WHERE "runId"=$1', [f.runId])).rowCount, 0)
        } finally { if (secretId) await pool.query('DELETE FROM user_secrets WHERE id=$1', [secretId]) }
      }
      assert.equal((await pool.query('SELECT 1 FROM coding_workspace_mentions WHERE "runId"=$1', [f.runId])).rowCount, 0)
    })

    await t.test('a successful receipt without its private policy fails closed even when its selected text is otherwise unchanged', async () => {
      const f = await fixture()
      await assert.rejects(() => afterStoredRead(f,
        signal => requestWorkspaceRead(pool, pool, actor, f.runId, f.repoId,
          { kind: 'file', path: 'src/example.ts', range: { startLine: 1, endLine: 1 } }, signal),
        async command => {
          await pool.query('UPDATE coding_workspace_requests SET "maskPolicy"=NULL WHERE id=$1', [command.id])
        }), errorCode('workspace_path_unavailable'))
      assert.equal((await pool.query('SELECT 1 FROM coding_workspace_requests WHERE "runId"=$1', [f.runId])).rowCount, 0)
    })

    await t.test('final source assertions and derived mentions preserve private proof policy and refuse a later multiline secret', async () => {
      const f = await fixture(), selection = { kind: 'file' as const, path: 'src/example.ts', range: { startLine: 1, endLine: 1 } }
      const { value } = await exchange(f, signal => requestWorkspaceRead(pool, pool, actor, f.runId, f.repoId, selection, signal))
      assert.ok(value.ok && value.kind === 'file')
      const { value: mention } = await exchange(f, signal => createFileMention(pool, pool, actor, f.runId, f.repoId, selection, signal))
      const { value: resolved } = await exchange(f, signal => resolveFileMentions(pool, pool, actor, f.runId, f.repoId, [mention.id], signal))
      const policy = (await secretMaskerFor({ workspaceId, ownerId: owner })).sourcePolicy
      assert.ok(policy)
      const copied = copyWorkspaceResultMaskPolicy(value, { ...value })
      for (const result of [value, mention, resolved, copied]) {
        assert.equal(workspaceResultMaskPolicy(result), policy, 'derived DTOs retain the full-proof policy')
        assert.ok(!JSON.stringify(result).includes(policy), 'the private marker is absent from API JSON')
        assert.equal(workspaceResultMaskPolicy({ ...result }), undefined, 'the marker is non-enumerable')
        await assertWorkspaceResultMaskPolicy(result, actor)
      }
      await assert.rejects(() => assertWorkspaceResultMaskPolicy(JSON.parse(JSON.stringify(value)), actor), errorCode('workspace_path_unavailable'))
      const secret = (await readFile(join(f.worktree, 'src/example.ts'), 'utf8')).trimEnd()
      const secretId = await registerOwnerSecret(secret)
      try {
        const freshMask = await secretMaskerFor({ workspaceId, ownerId: owner })
        assert.notEqual(freshMask.sourcePolicy, policy)
        assert.equal(freshMask(value.content!), value.content, 'a final partial-text mask cannot detect the full multiline value')
        assert.deepEqual(maskDeep(resolved, freshMask), resolved)
        for (const result of [value, mention, resolved, copied])
          await assert.rejects(() => assertWorkspaceResultMaskPolicy(result, actor), errorCode('workspace_path_unavailable'))
      } finally { await pool.query('DELETE FROM user_secrets WHERE id=$1', [secretId]) }
    })

    await t.test('a secret registered after mention resolution rolls back submission before commit and missing private evidence cannot enqueue context', async () => {
      const { f, resolved, submitActor } = await submissionFixture()
      const input = { runId: f.runId, repoId: f.repoId, text: 'Explain the selected source', requestId: randomUUID() }
      await assertWorkspaceResultMaskPolicy(resolved, actor)
      await assert.rejects(() => submitFileMentions(pool, pool, submitActor, input, { ...resolved }), errorCode('workspace_path_unavailable'))
      assert.equal((await pool.query('SELECT 1 FROM run_messages WHERE "runId"=$1', [f.runId])).rowCount, 0)
      const secret = (await readFile(join(f.worktree, 'src/example.ts'), 'utf8')).trimEnd()
      const secretId = await registerOwnerSecret(secret)
      try {
        const freshMask = await secretMaskerFor({ workspaceId, ownerId: owner })
        assert.deepEqual(maskDeep(resolved, freshMask), resolved, 'the selected first line does not reveal that the two-line source is now secret')
        await assert.rejects(() => submitFileMentions(pool, pool, submitActor, input, resolved), errorCode('workspace_path_unavailable'))
        assert.equal((await pool.query('SELECT 1 FROM run_messages WHERE "runId"=$1', [f.runId])).rowCount, 0,
          'the real inbox write is rolled back with its transaction')
        assert.equal((await pool.query('SELECT 1 FROM coding_workspace_requests WHERE "runId"=$1', [f.runId])).rowCount, 0)
      } finally { await pool.query('DELETE FROM user_secrets WHERE id=$1', [secretId]) }
    })

    await t.test('final authority locks block Stop and revocation while real secret loading waits, then release promptly', { timeout: 20_000 }, async () => {
      const f = await fixture(), { auth } = await import('../auth')
      const session = await (await auth.$context).internalAdapter.createSession(owner)
      assert.ok(session)
      const { value } = await exchange(f, signal => requestWorkspaceRead(pool, pool, actor, f.runId, f.repoId,
        { kind: 'file', path: 'src/example.ts', range: { startLine: 1, endLine: 1 } }, signal))
      assert.ok(value.ok && value.kind === 'file')
      const authorized = { ...actor, credential: { kind: 'session' as const, id: session.id } }
      const stop = `WITH locked AS (SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE NOWAIT)
        UPDATE agent_runs r SET "stopRequestedAt"=clock_timestamp() FROM locked WHERE r.id=locked.id`
      const revoke = `WITH locked AS (SELECT id FROM "session" WHERE id=$1 FOR UPDATE NOWAIT)
        DELETE FROM "session" s USING locked WHERE s.id=locked.id`
      const suspend = `WITH locked AS (SELECT "workspaceId","userId" FROM mikka_workspace_members
        WHERE "workspaceId"=$1 AND "userId"=$2 FOR UPDATE NOWAIT)
        UPDATE mikka_workspace_members m SET status='suspended' FROM locked
        WHERE m."workspaceId"=locked."workspaceId" AND m."userId"=locked."userId"`
      const blocker = await pool.connect(), entered = Promise.withResolvers<void>(), controller = new AbortController()
      let held = false, maskCompleted = false, suspended = false
      let pending: Promise<{ ok: true; response: Response } | { ok: false; error: unknown }> | undefined
      try {
        await blocker.query('BEGIN'); held = true
        await blocker.query('LOCK TABLE user_secrets IN ACCESS EXCLUSIVE MODE')
        pending = withWorkspaceAuthority(pool, pool, authorized, f.runId, async () => {
          const maskRead = secretMaskerFor({ workspaceId, ownerId: owner })
          entered.resolve()
          const mask = await maskRead
          maskCompleted = true
          assert.equal(mask.sourcePolicy, workspaceResultMaskPolicy(value))
          return Response.json(value)
        }, { live: value.identity, signal: controller.signal }).then(response => ({ ok: true as const, response }), error => ({ ok: false as const, error }))
        await Promise.race([entered.promise, pending.then(result => {
          if (!result.ok) throw result.error
          assert.fail('the real secret read must remain blocked before response serialization')
        })])
        for (const [sql, values] of [[stop, [f.runId]], [revoke, [session.id]], [suspend, [workspaceId, owner]]] as const)
          await assert.rejects(pool.query(sql, [...values]), { code: '55P03' }, 'actual writers cannot bypass the held read authority')
        assert.equal(maskCompleted, false, 'the full asynchronous secret read remains inside the authorization locks')
        assert.equal((await pool.query('SELECT "stopRequestedAt" FROM agent_runs WHERE id=$1', [f.runId])).rows[0].stopRequestedAt, null)
        assert.equal((await pool.query('SELECT 1 FROM "session" WHERE id=$1', [session.id])).rowCount, 1)
        assert.equal((await pool.query('SELECT status FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [workspaceId, owner])).rows[0].status, 'active')
        await blocker.query('ROLLBACK'); held = false
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const result = await Promise.race([pending, new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('authority read did not finish after releasing the secret lock')), 5000)
          })])
          if (!result.ok) throw result.error
          assert.equal(result.response.status, 200)
          assert.deepEqual(await result.response.json(), value)
        } finally { if (timer) clearTimeout(timer) }
        assert.equal(maskCompleted, true)
        assert.equal((await pool.query(stop, [f.runId])).rowCount, 1, 'Stop takes effect as soon as final read authority is released')
        await assert.rejects(() => withWorkspaceAuthority(pool, pool, authorized, f.runId, async () => {
          assert.fail('stopped authority cannot expose a second source response')
        }, { live: value.identity }), errorCode('workspace_machine_unavailable'))
        await pool.query('UPDATE agent_runs SET "stopRequestedAt"=NULL WHERE id=$1', [f.runId])
        assert.equal((await pool.query(revoke, [session.id])).rowCount, 1)
        await assert.rejects(() => withWorkspaceAuthority(pool, pool, authorized, f.runId, async () => {
          assert.fail('a revoked session cannot expose a second source response')
        }, { live: value.identity }), errorCode('workspace_not_found'))
        suspended = (await pool.query(suspend, [workspaceId, owner])).rowCount === 1
        assert.equal(suspended, true, 'membership revocation is also released after response construction')
      } finally {
        controller.abort()
        if (held) await blocker.query('ROLLBACK')
        blocker.release()
        if (pending) await pending
        if (suspended) await pool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspaceId, owner])
      }
    })

    await t.test('revocation after delivery is rechecked before source reaches the waiting requester', async () => {
      const f = await fixture(), subscription = await subscribeShared(pool, DEVICE_WORK_CHANNEL, [f.deviceId])
      assert.ok(subscription)
      const controller = new AbortController()
      const outcome = requestWorkspaceRead(pool, pool, actor, f.runId, f.repoId, { kind: 'file', path: 'README.md' }, controller.signal)
      const rejected = assert.rejects(outcome, errorCode('workspace_not_found'))
      try {
        assert.equal(await subscription.next(5000), 'notified')
        const [command] = await pendingWorkspaceReads(pool, pool, f.caller, f.deviceId)
        assert.ok(command)
        const receipt = await readWorkspaceReceipt(command, f.entry)
        // Atomic state change models a revocation committed before the result
        // notification; it cannot rely on the earlier device-side check.
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          await client.query('UPDATE coding_workspace_requests SET result=$2 WHERE id=$1', [command.id, receipt.result])
          await client.query('UPDATE device_tokens SET "revokedAt"=now() WHERE id=$1', [f.tokenId])
          await notifyChannel(client, DEVICE_WORK_CHANNEL, [`workspace:${command.id}`])
          await client.query('COMMIT')
        } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
        await rejected
        assert.equal((await pool.query('SELECT 1 FROM coding_workspace_requests WHERE id=$1', [command.id])).rowCount, 0)
      } finally { controller.abort(); subscription.close(); await rejected }
    })

    await t.test('mention uses a fresh source CAS; dirty-file edits, tenant changes, expiry and VM replacement invalidate it', async () => {
      const f = await fixture(true)
      const { value: mention } = await exchange(f, signal => createFileMention(pool, pool, actor, f.runId, f.repoId, { kind: 'file', path: 'src/example.ts', range: { startLine: 1, endLine: 1 } }, signal))
      const persisted = (await pool.query('SELECT files FROM coding_workspace_mentions WHERE id=$1', [mention.id])).rows[0].files
      assert.equal(persisted[0].expected.headSha, f.entry.baseCommit)
      assert.equal('content' in persisted[0], false, 'durable references store a digest, not source text')
      const { value: resolved } = await exchange(f, signal => resolveFileMentions(pool, pool, actor, f.runId, f.repoId, [mention.id, mention.id], signal))
      assert.deepEqual(resolved.ids, [mention.id])
      assert.equal(resolved.files[0]!.content, 'export const answer = 42')
      await assert.rejects(() => resolveFileMentions(pool, pool, { userId: member, workspaceId }, f.runId, f.repoId, [mention.id]), errorCode('workspace_not_found'))
      await pool.query('UPDATE coding_workspace_mentions SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1', [mention.id])
      await assert.rejects(() => resolveFileMentions(pool, pool, actor, f.runId, f.repoId, [mention.id]), errorCode('workspace_request_expired'))
      await pool.query('UPDATE coding_workspace_mentions SET "expiresAt"=now()+interval \'5 minutes\' WHERE id=$1', [mention.id])
      await writeFile(join(f.worktree, 'src/example.ts'), 'export const answer = 99\nexport const label = "fixture"\n')
      await assert.rejects(() => exchange(f, signal => resolveFileMentions(pool, pool, actor, f.runId, f.repoId, [mention.id], signal)), errorCode('workspace_version_conflict'))
      await pool.query('UPDATE thread_machines SET epoch=epoch+1 WHERE "runId"=$1', [f.runId])
      await assert.rejects(() => resolveFileMentions(pool, pool, actor, f.runId, f.repoId, [mention.id]), errorCode('workspace_version_conflict'))
    })

    await t.test('mention create and resolve reauthenticate real sessions and PATs after a pending device read', async () => {
      const f = await fixture(), { auth } = await import('../auth')
      const { createLegacyPersonalAccessToken } = await import('../tokens/store')
      const { POST } = await import('../../app/api/runs/[runId]/workspace/mentions/route')
      const { value: mention } = await exchange(f, signal => createFileMention(pool, pool, actor, f.runId, f.repoId,
        { kind: 'file', path: 'src/example.ts', range: { startLine: 1, endLine: 1 } }, signal))
      const origin = 'http://127.0.0.1:3199', endpoint = `${origin}/api/runs/${f.runId}/workspace/mentions`
      for (const action of ['create', 'resolve'] as const) for (const type of ['session', 'pat'] as const) {
        const session = type === 'session' ? await (await auth.$context).internalAdapter.createSession(owner) : null
        const pat = type === 'pat' ? await createLegacyPersonalAccessToken(owner, workspaceId, { name: `Workspace in-flight ${action}` }) : null
        const credential = session?.token ?? pat?.token
        assert.ok(credential)
        const body = { action, repoId: f.repoId, workspaceId, ...(action === 'create'
          ? { selection: { kind: 'file', path: 'src/example.ts', range: { startLine: 1, endLine: 1 } } }
          : { ids: [mention.id] }) }
        const { value: response } = await exchange(f, signal => POST(new Request(endpoint, { method: 'POST', signal,
          headers: { authorization: `Bearer ${credential}`, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        { params: Promise.resolve({ runId: f.runId }) }), async () => {
          if (session) await (await auth.$context).internalAdapter.deleteSession(session.token)
          else await pool.query('UPDATE personal_access_tokens SET "revokedAt"=now() WHERE id=$1', [pat!.id])
        })
        assert.equal(response.status, 401, `${action} rechecks revoked ${type} before exposing source or reference metadata`)
        assert.equal(response.headers.get('cache-control'), 'private, no-store')
        assert.deepEqual(await response.json(), { ok: false, code: 'authRequired' })
      }
    })

    await t.test('file context submission targets the exact Run and a repeated request never writes a second owner message', async () => {
      const { f, resolved, submitActor } = await submissionFixture()
      const input = { runId: f.runId, repoId: f.repoId, text: 'Explain this selected source', requestId: randomUUID() }
      const [first, concurrentReplay] = await Promise.all([
        submitFileMentions(pool, pool, submitActor, input, resolved),
        submitFileMentions(pool, pool, submitActor, input, resolved),
      ])
      assert.deepEqual(concurrentReplay, first)
      assert.equal(first.runId, f.runId)
      assert.equal(first.continued, false)
      const rows = (await pool.query('SELECT id,"runId","userId",origin,text FROM run_messages WHERE "runId"=$1', [f.runId])).rows
      assert.equal(rows.length, 1)
      assert.equal(rows[0].id, first.messageId)
      assert.equal(rows[0].runId, f.runId)
      assert.equal(rows[0].userId, owner)
      assert.equal(rows[0].origin, 'owner')
      assert.ok(rows[0].text.includes(input.text))
      assert.ok(rows[0].text.includes(f.runId) && rows[0].text.includes(f.repoId) && rows[0].text.includes(f.entry.baseCommit!))
      assert.ok(rows[0].text.includes('export const answer = 42'))
      assert.deepEqual(await submitFileMentions(pool, pool, submitActor, input, resolved), first)
      await assert.rejects(() => submitFileMentions(pool, pool, submitActor, { ...input, text: 'A different instruction under the same id' }, resolved),
        (error: unknown) => error instanceof ActionFailureError && error.code === 'submissionConflict')
      assert.deepEqual((await pool.query('SELECT id,"runId","userId",origin,text FROM run_messages WHERE "runId"=$1', [f.runId])).rows, rows)
    })

    await t.test('context observed on Run A never follows its successor or becomes a message to Run B', async () => {
      const { f: a, resolved, submitActor } = await submissionFixture(), b = await fixture()
      await pool.query('UPDATE agent_runs SET "continuesRunId"=$2,"createdAt"=clock_timestamp()+interval \'1 second\' WHERE id=$1', [b.runId, a.runId])
      const input = { runId: a.runId, repoId: a.repoId, text: 'Use the source observed on A', requestId: randomUUID() }
      await assert.rejects(() => submitFileMentions(pool, pool, submitActor, input, resolved), errorCode('workspace_version_conflict'))
      await assert.rejects(() => submitFileMentions(pool, pool, submitActor, { ...input, runId: b.runId, repoId: b.repoId }, resolved), errorCode('workspace_not_found'))
      assert.equal((await pool.query('SELECT 1 FROM run_messages WHERE "runId"=ANY($1::uuid[])', [[a.runId, b.runId]])).rowCount, 0)
      assert.equal((await pool.query('SELECT "continuesRunId" FROM agent_runs WHERE id=$1', [b.runId])).rows[0].continuesRunId, a.runId)
    })

    await t.test('exact Run submission rejects terminal, stopped, revoked-session and replaced-VM observations without inbox writes', async () => {
      const { f, session, resolved, submitActor } = await submissionFixture(true)
      const input = { runId: f.runId, repoId: f.repoId, text: 'Use the validated source', requestId: randomUUID() }
      await pool.query('UPDATE agent_runs SET status=\'succeeded\',"finishedAt"=now() WHERE id=$1', [f.runId])
      await assert.rejects(() => submitFileMentions(pool, pool, submitActor, input, resolved),
        (error: unknown) => error instanceof ActionFailureError && error.code === 'runNotFound')
      await pool.query('UPDATE agent_runs SET status=\'running\',"finishedAt"=NULL,"stopRequestedAt"=now() WHERE id=$1', [f.runId])
      await assert.rejects(() => submitFileMentions(pool, pool, submitActor, input, resolved), errorCode('workspace_machine_unavailable'))
      await pool.query('UPDATE agent_runs SET "stopRequestedAt"=NULL WHERE id=$1', [f.runId])
      await pool.query('UPDATE thread_machines SET epoch=epoch+1 WHERE "runId"=$1', [f.runId])
      await assert.rejects(() => submitFileMentions(pool, pool, submitActor, input, resolved), errorCode('workspace_version_conflict'))
      await pool.query('UPDATE thread_machines SET epoch=epoch-1 WHERE "runId"=$1', [f.runId])
      const { auth } = await import('../auth')
      await (await auth.$context).internalAdapter.deleteSession(session.token)
      await assert.rejects(() => submitFileMentions(pool, pool, submitActor, input, resolved), errorCode('workspace_not_found'))
      assert.equal((await pool.query('SELECT 1 FROM run_messages WHERE "runId"=$1', [f.runId])).rowCount, 0)
    })

    await t.test('an active Factory current attempt accepts source context without advancing its request epoch or revision', async () => {
      const { f, resolved, submitActor, attemptId, sourceEventId, snapshot } = await factorySubmissionFixture()
      const before = await snapshot()
      assert.equal(before.task.sourceEventId, sourceEventId)
      assert.equal(before.task.attemptId, attemptId)
      assert.equal(before.task.revision, 7)
      assert.equal(before.task.status, 'running')
      assert.equal(before.attempts.length, 1)
      assert.equal(before.attempts[0].runId, f.runId)
      assert.equal(before.attempts[0].status, 'running')
      const result = await submitFileMentions(pool, pool, submitActor,
        { runId: f.runId, repoId: f.repoId, text: 'Use this source in the current Factory attempt', requestId: randomUUID() }, resolved)
      assert.equal(result.runId, f.runId)
      assert.equal(result.continued, false)
      assert.deepEqual(await snapshot(), before, 'context is an inbox supplement, with no task, attempt, event or request-epoch mutation')
      const messages = (await pool.query('SELECT id,"runId",origin,text FROM run_messages WHERE "runId"=$1', [f.runId])).rows
      assert.equal(messages.length, 1)
      assert.equal(messages[0].id, result.messageId)
      assert.equal(messages[0].runId, f.runId)
      assert.equal(messages[0].origin, 'owner')
      assert.ok(messages[0].text.includes('export const answer = 42'))
    })

    await t.test('a Factory task moved to attempt B rejects still-active A without writing to either Run', async () => {
      const { f: a, resolved, submitActor, issueId, taskId, attemptId, snapshot } = await factorySubmissionFixture()
      const b = await fixture(), nextAttempt = randomUUID(), nextSource = randomUUID()
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('UPDATE agent_runs SET "issueId"=$2,"agentDefinition"="agentDefinition"-\'repositoryAdmission\' WHERE id=$1', [b.runId, issueId])
        await client.query(`INSERT INTO coordinator_events(id,"userId","issueId",kind,"dedupeKey",payload)
          VALUES($1::uuid,$2,$3,'user_message',$1::text,$4)`, [nextSource, owner, issueId, { text: 'A new request for Factory attempt B' }])
        await client.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"runId",reason,output)
          VALUES($1,$2,'execute',2,2,'running',$3,'New current Factory attempt',$4)`, [nextAttempt, taskId, b.runId, { requestEpoch: nextSource }])
        await client.query('UPDATE factory_tasks SET "attemptId"=$2,"sourceEventId"=$3,revision=revision+1 WHERE id=$1', [taskId, nextAttempt, nextSource])
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
      // No continuation/retry link: a missing Factory fence would let A pass
      // the independent latest-Run check and incorrectly accept this context.
      const { readRunChain } = await import('../run-chain')
      assert.equal((await readRunChain(pool, owner, a.runId))?.latestRunId, a.runId)
      assert.equal((await resolve(a)).identity.bindingId, resolved.identity.bindingId)
      assert.equal((await pool.query('SELECT 1 FROM agent_runs WHERE id=ANY($1::uuid[]) AND status=\'running\' AND "stopRequestedAt" IS NULL', [[a.runId, b.runId]])).rowCount, 2)
      assert.equal((await pool.query('SELECT status FROM factory_attempts WHERE id=$1', [attemptId])).rows[0].status, 'running')
      const before = await snapshot()
      assert.equal(before.task.attemptId, nextAttempt)
      assert.equal(before.task.sourceEventId, nextSource)
      assert.equal(before.task.revision, 8)
      assert.equal(before.attempts[1].runId, b.runId)
      await assert.rejects(() => submitFileMentions(pool, pool, submitActor,
        { runId: a.runId, repoId: a.repoId, text: 'Stale context for the old Factory attempt', requestId: randomUUID() }, resolved), errorCode('workspace_version_conflict'))
      assert.equal((await pool.query('SELECT 1 FROM run_messages WHERE "runId"=ANY($1::uuid[])', [[a.runId, b.runId]])).rowCount, 0)
      assert.deepEqual(await snapshot(), before, 'rejecting stale A must not mutate current B or advance the task again')
    })
  } finally {
    mock.restoreAll()
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name] }
    await dropTestDatabase(admin, database, pool, appPool, workspacePool)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})
