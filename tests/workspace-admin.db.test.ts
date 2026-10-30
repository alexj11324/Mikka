// Workspace settings › General / Members / Teams against a real PostgreSQL.
// Every destructive case seeds a second workspace and proves it is untouched.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { count, dbUrl, seedAgent, seedBot, seedProject, seedRun, seedTeam, seedTeamIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('workspace settings backend', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const { WorkspaceError } = await import('../lib/workspace-access')
  const general = await import('../lib/workspace-admin/general')
  const members = await import('../lib/workspace-admin/members')
  const teamAdmin = await import('../lib/workspace-admin/teams')
  const botAdmin = await import('../lib/workspace-admin/bots')
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  t.after(async () => { await Promise.all([pool.end(), appPool.end(), workspacePool.end()]) })
  const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof WorkspaceError && error.code === code)

  await t.test('updateWorkspaceGeneral: name, icon, slug with redirect, uniqueness and admin-only', async () => {
    const admin = await seedUser(pool, 'admin'), member = await seedUser(pool, 'member')
    const ws = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'member' }])
    const other = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }])
    await rejects(general.updateWorkspaceGeneral(member, ws.id, { name: 'Nope' }), 'workspaceAccessDenied')
    const png = `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]).toString('base64')}`
    const renamed = await general.updateWorkspaceGeneral(admin, ws.id, { name: 'Renamed', icon: png })
    assert.equal(renamed.name, 'Renamed')
    assert.equal(renamed.icon, png)
    await rejects(general.updateWorkspaceGeneral(admin, ws.id, { icon: 'data:image/svg+xml;base64,PHN2Zz4=' }), 'workspaceIconInvalid')
    await rejects(general.updateWorkspaceGeneral(admin, ws.id, { slug: other.slug }), 'workspaceSlugTaken')
    const newSlug = `moved-${randomUUID().slice(0, 8)}`
    const moved = await general.updateWorkspaceGeneral(admin, ws.id, { slug: newSlug })
    assert.equal(moved.slug, newSlug)
    assert.equal(await general.resolveSlugRedirect(ws.slug, admin), newSlug)
    assert.equal(await general.resolveSlugRedirect(ws.slug, member), newSlug)
    const stranger = await seedUser(pool, 'stranger')
    assert.equal(await general.resolveSlugRedirect(ws.slug, stranger), null, 'non-members learn nothing')
    // The old slug is reserved: another workspace cannot take it.
    await rejects(general.updateWorkspaceGeneral(admin, other.id, { slug: ws.slug }), 'workspaceSlugTaken')
    // Taking it back removes the redirect.
    await general.updateWorkspaceGeneral(admin, ws.id, { slug: ws.slug })
    assert.equal(await count(pool, 'mikka_workspace_slug_redirects where slug=$1', [ws.slug]), 0)
    assert.equal(await count(pool, 'mikka_workspace_slug_redirects where slug=$1', [newSlug]), 1)
    const cleared = await general.updateWorkspaceGeneral(admin, ws.id, { icon: null })
    assert.equal(cleared.icon, null)
  })

  await t.test('deleteWorkspaceData: name check, full cleanup, other workspace untouched, personal data kept', async () => {
    const admin = await seedUser(pool, 'admin'), member = await seedUser(pool, 'member')
    const ws = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'member' }], 'Doomed')
    const keep = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'member' }], 'Keep')
    const seed = async (workspaceId: string) => {
      const bot = await seedBot(pool, workspaceId, member)
      const agent = await seedAgent(pool, member)
      const run = await seedRun(pool, { userId: member, agentId: agent, botId: bot })
      const team = await seedTeam(pool, workspaceId, admin)
      const issue = await seedTeamIssue(pool, workspaceId, team.id, admin)
      const project = await seedProject(pool, admin, [{ teamId: team.id, workspaceId }])
      await pool.query(`insert into conversations (id,"workspaceId",kind,title,"createdBy") values ($1,$2,'group','G',$3)`, [randomUUID(), workspaceId, admin])
      await pool.query(`insert into mikka_workspace_invitations (id,"workspaceId","userId",email,role,"tokenHash","expiresAt") values ($1,$2,$3,$4,'member',$5,now()+interval '1 day')`, [randomUUID(), workspaceId, admin, `${randomUUID()}@example.invalid`, randomUUID()])
      await pool.query(`insert into byos_connections (id,"ownerId","workspaceId",provider) values ($1,$2,$3,'codex')`, [randomUUID(), member, workspaceId])
      await pool.query('insert into workspace_settings ("workspaceId","defaultModel") values ($1,\'mikka\')', [workspaceId])
      return { bot, run, team, issue, project }
    }
    const doomed = await seed(ws.id)
    const kept = await seed(keep.id)
    const personalIssue = (await pool.query(`insert into issues (id,"userId",title,content,status,priority) values ($1,$2,'Mine','{}','todo','normal') returning id`, [randomUUID(), member])).rows[0].id

    await rejects(general.deleteWorkspaceData(member, ws.id, 'Doomed'), 'workspaceAccessDenied')
    await rejects(general.deleteWorkspaceData(admin, ws.id, 'doomed'), 'workspaceDeleteNameMismatch')
    await pool.query(`insert into workspace_billing ("workspaceId",status) values ($1,'active')`, [ws.id])
    await rejects(general.deleteWorkspaceData(admin, ws.id, 'Doomed'), 'workspaceHasActiveSubscription')
    assert.equal(await count(pool, 'bots where id=$1', [doomed.bot]), 1, 'a refused delete changes nothing')
    await pool.query(`update workspace_billing set status='canceled' where "workspaceId"=$1`, [ws.id])

    const result = await general.deleteWorkspaceData(admin, ws.id, ' Doomed ')
    assert.deepEqual(result.deleted, { bots: 1, threads: 1, tasks: 1, projects: 1, teams: 1, invitations: 1, members: 2 })
    assert.equal(result.nextWorkspaceId, keep.id)
    for (const [table, id] of [['mikka_workspaces where id=$1', ws.id], ['mikka_workspace_members where "workspaceId"=$1', ws.id], ['mikka_teams where "workspaceId"=$1', ws.id], ['bots where id=$1', doomed.bot], ['agent_runs where id=$1', doomed.run], ['issues where id=$1', doomed.issue], ['workspace_projects where id=$1', doomed.project], ['conversations where "workspaceId"=$1', ws.id], ['workspace_settings where "workspaceId"=$1', ws.id], ['workspace_billing where "workspaceId"=$1', ws.id], ['mikka_workspace_invitations where "workspaceId"=$1', ws.id]] as const) {
      assert.equal(await count(pool, table, [id]), 0, table)
    }
    for (const [table, id] of [['mikka_workspaces where id=$1', keep.id], ['mikka_workspace_members where "workspaceId"=$1', keep.id], ['bots where id=$1', kept.bot], ['agent_runs where id=$1', kept.run], ['issues where id=$1', kept.issue], ['workspace_projects where id=$1', kept.project], ['conversations where "workspaceId"=$1', keep.id], ['mikka_teams where id=$1', kept.team.id], ['workspace_settings where "workspaceId"=$1', keep.id], ['mikka_workspace_invitations where "workspaceId"=$1', keep.id]] as const) {
      assert.ok(await count(pool, table, [id]) >= 1, `kept: ${table}`)
    }
    assert.equal(await count(pool, 'mikka_workspace_members where "workspaceId"=$1', [keep.id]), 2)
    assert.equal(await count(pool, '"user" where id = any($1)', [[admin, member]]), 2, 'accounts stay')
    assert.equal(await count(pool, 'issues where id=$1', [personalIssue]), 1, 'personal tasks stay')
    assert.equal(await count(pool, 'byos_connections where "ownerId"=$1 and "workspaceId"=$2', [member, ws.id]), 1, 'personal model subscriptions stay')
  })

  await t.test('removeMember: guards, immediate access loss, bot transfer', async () => {
    const admin = await seedUser(pool, 'admin'), leaving = await seedUser(pool, 'leaving'), heir = await seedUser(pool, 'heir')
    const ws = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: leaving, role: 'member' }, { userId: heir, role: 'member' }])
    const elsewhere = await seedWorkspace(pool, leaving, [{ userId: leaving, role: 'admin' }])
    const team = await seedTeam(pool, ws.id, admin)
    await pool.query('insert into mikka_team_members ("teamId","userId") values ($1,$2)', [team.id, leaving])
    const bot = await seedBot(pool, ws.id, leaving, 'Helper')
    const otherBot = await seedBot(pool, elsewhere.id, leaving, 'Helper')
    const versionId = randomUUID()
    await pool.query('insert into agent_kit_heads (owner_id,bot_key,bot_id,workspace_id) values ($1,$2,$3,$4)', [leaving, bot, bot, ws.id])
    await pool.query(`insert into agent_kit_versions (id,owner_id,bot_key,version,definition,digest,source,request_key) values ($1,$2,$3,1,'{}',$4,'user','r1')`, [versionId, leaving, bot, 'a'.repeat(64)])
    await pool.query('update agent_kit_heads set active_version=$1 where owner_id=$2 and bot_key=$3', [versionId, leaving, bot])

    await rejects(members.removeMember(admin, ws.id, admin), 'workspaceCannotRemoveSelf')
    await rejects(members.removeMember(heir, ws.id, leaving), 'workspaceAccessDenied')
    await rejects(members.removeMember(admin, ws.id, leaving, leaving), 'workspaceTransferTargetInvalid')
    await rejects(members.removeMember(admin, ws.id, leaving, `${randomUUID()}`), 'workspaceTransferTargetInvalid')
    const agent = await seedAgent(pool, leaving)
    const live = await seedRun(pool, { userId: leaving, agentId: agent, botId: bot, status: 'running', startedAt: new Date() })
    await rejects(members.removeMember(admin, ws.id, leaving, heir), 'botTransferBusy')
    await pool.query(`update agent_runs set status='succeeded', "finishedAt"=now() where id=$1`, [live])
    const clash = await seedBot(pool, ws.id, heir, 'helper')
    await rejects(members.removeMember(admin, ws.id, leaving, heir), 'botTransferNameConflict')
    await pool.query('delete from bots where id=$1', [clash])
    assert.equal(await count(pool, 'mikka_workspace_members where "workspaceId"=$1 and "userId"=$2', [ws.id, leaving]), 1, 'refusals change nothing')

    const removed = await members.removeMember(admin, ws.id, leaving, heir)
    assert.deepEqual(removed, { removed: true, transferred: { bots: 1 } })
    assert.equal(await count(pool, 'mikka_workspace_members where "workspaceId"=$1 and "userId"=$2', [ws.id, leaving]), 0)
    assert.equal(await count(pool, 'mikka_team_members where "teamId"=$1 and "userId"=$2', [team.id, leaving]), 0)
    assert.equal(await count(pool, 'bots where id=$1 and "ownerId"=$2', [bot, heir]), 1)
    assert.equal(await count(pool, 'agent_kit_heads where bot_id=$1', [bot]), 0, 'owner-bound agent kit history is removed')
    assert.equal(await count(pool, 'agent_kit_versions where id=$1', [versionId]), 0)
    assert.equal(await count(pool, 'bots where id=$1 and "ownerId"=$2', [otherBot, leaving]), 1, 'bots in other workspaces stay with their owner')
    assert.equal(await count(pool, 'mikka_workspace_members where "workspaceId"=$1 and "userId"=$2', [elsewhere.id, leaving]), 1)
    // The removed member's next request fails the membership check for this workspace.
    const { workspaceDb } = await import('../lib/workspace-db')
    const { requireWorkspace } = await import('../lib/workspace-access')
    await rejects(workspaceDb.transaction(tx => requireWorkspace(tx, ws.id, leaving)), 'workspaceAccessDenied')
  })

  await t.test('removeMember: a suspended admin cannot act, and admins cannot remove themselves', async () => {
    // The actor is always an active admin, so removing someone else always leaves one; the
    // last-admin guard still protects against concurrent demotions inside the same lock.
    const admin = await seedUser(pool, 'admin'), second = await seedUser(pool, 'second')
    const ws = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: second, role: 'admin', status: 'suspended' }])
    await rejects(members.removeMember(second, ws.id, admin), 'workspaceAccessDenied')
    await rejects(members.removeMember(admin, ws.id, admin), 'workspaceCannotRemoveSelf')
    await members.removeMember(admin, ws.id, second)
    assert.equal(await count(pool, 'mikka_workspace_members where "workspaceId"=$1', [ws.id]), 1)
  })

  await t.test('suspend with transferTo hands bots over', async () => {
    const admin = await seedUser(pool, 'admin'), target = await seedUser(pool, 'target'), heir = await seedUser(pool, 'heir')
    const ws = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: target, role: 'member' }, { userId: heir, role: 'member' }])
    const bot = await seedBot(pool, ws.id, target)
    const { workspaceDb } = await import('../lib/workspace-db')
    const moved = await workspaceDb.transaction(tx => members.transferOnSuspend(tx, ws.id, target, heir))
    assert.deepEqual(moved, { bots: 1 })
    assert.equal(await count(pool, 'bots where id=$1 and "ownerId"=$2', [bot, heir]), 1)
  })

  await t.test('team deletion: impact counts, name check, scoped delete', async () => {
    const admin = await seedUser(pool, 'admin'), member = await seedUser(pool, 'member')
    const ws = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'member' }])
    const other = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }])
    const team = await seedTeam(pool, ws.id, admin, 'Platform')
    const sibling = await seedTeam(pool, ws.id, admin, 'Design')
    const foreign = await seedTeam(pool, other.id, admin, 'Platform')
    const tasks = [await seedTeamIssue(pool, ws.id, team.id, admin), await seedTeamIssue(pool, ws.id, team.id, member)]
    const siblingTask = await seedTeamIssue(pool, ws.id, sibling.id, admin)
    const foreignTask = await seedTeamIssue(pool, other.id, foreign.id, admin)
    const own = await seedProject(pool, admin, [{ teamId: team.id, workspaceId: ws.id }])
    const shared = await seedProject(pool, admin, [{ teamId: team.id, workspaceId: ws.id }, { teamId: sibling.id, workspaceId: ws.id }])
    const foreignProject = await seedProject(pool, admin, [{ teamId: foreign.id, workspaceId: other.id }])

    await rejects(teamAdmin.teamDeletionImpact(member, team.id), 'workspaceAccessDenied')
    await rejects(teamAdmin.teamDeletionImpact(admin, randomUUID()), 'teamNotFound')
    assert.deepEqual(await teamAdmin.teamDeletionImpact(admin, team.id), { teamId: team.id, name: 'Platform', tasks: 2, projects: 1 })
    await rejects(teamAdmin.deleteTeamData(member, team.id, 'Platform'), 'workspaceAccessDenied')
    await rejects(teamAdmin.deleteTeamData(admin, team.id, 'platform'), 'teamDeleteNameMismatch')
    assert.deepEqual(await teamAdmin.deleteTeamData(admin, team.id, 'Platform'), { deleted: { tasks: 2, projects: 1 } })
    assert.equal(await count(pool, 'mikka_teams where id=$1', [team.id]), 0)
    assert.equal(await count(pool, 'issues where id = any($1)', [tasks]), 0)
    assert.equal(await count(pool, 'workspace_projects where id=$1', [own]), 0)
    assert.equal(await count(pool, 'workspace_projects where id=$1', [shared]), 1, 'a shared project stays with the other team')
    assert.equal(await count(pool, 'mikka_team_projects where "projectId"=$1', [shared]), 1)
    assert.equal(await count(pool, 'issues where id = any($1)', [[siblingTask, foreignTask]]), 2)
    assert.equal(await count(pool, 'mikka_teams where id = any($1)', [[sibling.id, foreign.id]]), 2)
    assert.equal(await count(pool, 'workspace_projects where id=$1', [foreignProject]), 1)
  })

  await t.test('bot defaults: options from member installations, admin-only writes, live thread counts', async () => {
    const admin = await seedUser(pool, 'admin'), member = await seedUser(pool, 'member'), outsider = await seedUser(pool, 'outsider')
    const ws = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'member' }])
    const other = await seedWorkspace(pool, outsider, [{ userId: outsider, role: 'admin' }])
    const repo = `acme/${randomUUID().slice(0, 8)}`, foreignRepo = `other/${randomUUID().slice(0, 8)}`
    await pool.query('insert into github_repository_installations ("userId","remoteKey","githubAccountId","installationId","repositoryId") values ($1,$2,\'1\',1,1)', [member, repo])
    await pool.query('insert into github_repository_installations ("userId","remoteKey","githubAccountId","installationId","repositoryId") values ($1,$2,\'2\',2,2)', [outsider, foreignRepo])
    const options = await botAdmin.botDefaultOptions(ws.id)
    assert.deepEqual(options.models, ['mikka', 'codex', 'claude'])
    assert.deepEqual(options.repositories, [repo])
    assert.equal(options.defaultModel, null)
    await rejects(botAdmin.saveBotDefaults(member, ws.id, { defaultModel: 'codex' }), 'workspaceAccessDenied')
    await rejects(botAdmin.saveBotDefaults(admin, ws.id, { defaultRepository: foreignRepo }), 'botDefaultRepositoryUnavailable')
    await assert.rejects(botAdmin.saveBotDefaults(admin, ws.id, { defaultModel: 'gpt-x' as never }))
    assert.equal(options.version, 0)
    assert.deepEqual(await botAdmin.saveBotDefaults(admin, ws.id, { defaultModel: 'codex', defaultRepository: repo }), { defaultModel: 'codex', defaultRepository: repo, version: 1 })
    assert.deepEqual(await botAdmin.saveBotDefaults(admin, ws.id, { defaultRepository: null }), { defaultModel: 'codex', defaultRepository: null, version: 2 })
    assert.deepEqual(await botAdmin.workspaceBotDefaults(other.id), { defaultModel: null, defaultRepository: null }, 'defaults are per workspace')

    // BE-15 optimistic lock: a stale expectedVersion writes nothing and reports the current value.
    assert.deepEqual(await botAdmin.saveBotDefaults(admin, ws.id, { defaultModel: 'claude', expectedVersion: 2 }), { defaultModel: 'claude', defaultRepository: null, version: 3 })
    const stale = await botAdmin.saveBotDefaults(admin, ws.id, { defaultModel: 'mikka', expectedVersion: 2 }).then(() => null, (error: unknown) => error as { code?: string; current?: unknown })
    assert.equal(stale?.code, 'botDefaultsConflict')
    assert.deepEqual(stale?.current, { defaultModel: 'claude', defaultRepository: null, version: 3 })
    assert.deepEqual(await botAdmin.workspaceBotDefaults(ws.id), { defaultModel: 'claude', defaultRepository: null }, 'stale save left the row unchanged')
    // A fresh workspace (no row yet) is version 0; a stale non-zero version must not create a row with its value.
    await assert.rejects(botAdmin.saveBotDefaults(outsider, other.id, { defaultModel: 'codex', expectedVersion: 5 }), (error: { code?: string; current?: unknown }) => error.code === 'botDefaultsConflict' && (error.current as { version: number }).version === 0)
    // Two admins race from the same version: exactly one wins.
    const race = await Promise.allSettled([
      botAdmin.saveBotDefaults(admin, ws.id, { defaultModel: 'codex', expectedVersion: 3 }),
      botAdmin.saveBotDefaults(admin, ws.id, { defaultModel: 'mikka', expectedVersion: 3 }),
    ])
    assert.deepEqual(race.map(r => r.status).sort(), ['fulfilled', 'rejected'])
    const winner = (race.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<{ defaultModel: string; version: number }>).value
    assert.equal(winner.version, 4)
    assert.equal((await botAdmin.botDefaultOptions(ws.id)).defaultModel, winner.defaultModel)
    // Omitting expectedVersion keeps last-write-wins for old clients.
    assert.equal((await botAdmin.saveBotDefaults(admin, ws.id, { defaultModel: 'mikka' })).version, 5)

    const idle = await seedBot(pool, ws.id, admin, 'Idle')
    const busy = await seedBot(pool, ws.id, member, 'Busy')
    await seedBot(pool, other.id, outsider, 'Elsewhere')
    const agent = await seedAgent(pool, member)
    await seedRun(pool, { userId: member, agentId: agent, botId: busy, status: 'running', startedAt: new Date() })
    await seedRun(pool, { userId: member, agentId: agent, botId: busy, status: 'queued' })
    await seedRun(pool, { userId: member, agentId: agent, botId: busy, status: 'succeeded' })
    const listed = await botAdmin.workspaceBots(ws.id)
    assert.deepEqual(listed.map(bot => [bot.id, bot.status, bot.runningThreads, bot.ownerName]), [[idle, 'idle', 0, admin], [busy, 'running', 2, member]])
  })

  // ---- BE-15 concurrency. The workspace-row FOR UPDATE in requireWorkspace(..., true) is the main
  // guarantee (saves on one workspace run one after the other); the expectedVersion CAS is the second
  // layer for a stale version across sessions. The mutants below are copies of the real modules with
  // one guard removed, written next to the originals and deleted afterwards, so this is re-runnable.
  const { mkdtemp, readFile, rm, symlink, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join, resolve } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  // Mutants live under os.tmpdir(), never in the source tree. '@/' imports point back at the real
  // modules (same instances, same pools); bare packages resolve through a node_modules symlink.
  const root = resolve('.')
  const mutantDir = await mkdtemp(join(tmpdir(), 'be15-mutant-'))
  await symlink(join(root, 'node_modules'), join(mutantDir, 'node_modules'), 'dir')
  await writeFile(join(mutantDir, 'package.json'), '{"type":"module"}\n') // ESM like the repo, so the server-only loader hook applies
  t.after(async () => { await rm(mutantDir, { recursive: true, force: true }) })
  const LOCK_ANCHOR = ".for('update').limit(1)\n  if (!row || (admin"
  const CAS_ANCHOR = `    const match = expectedVersion === undefined
      ? eq(workspaceSettings.workspaceId, workspaceId)
      : and(eq(workspaceSettings.workspaceId, workspaceId), eq(workspaceSettings.botDefaultsVersion, expectedVersion))`
  // Mutant N2: compare the version in JS, then write by workspaceId only (not atomic).
  const CAS_MUTANT = `    const seen = await versionedBotDefaults(workspaceId)
    if (expectedVersion !== undefined && seen.version !== expectedVersion) throw new BotDefaultsConflictError(seen)
    const match = eq(workspaceSettings.workspaceId, workspaceId)`
  const mutate = (source: string, anchor: string, replacement: string, label: string) => {
    if (!source.includes(anchor)) throw new Error(`BE-15 mutant ${label}: anchor not found in the real module; update the mutant`)
    return source.replace(anchor, replacement)
  }
  const realImports = (source: string) => source.replaceAll("from '@/", `from '${root}/`)
  const botsMutant = async (guards: { lock: boolean; cas: boolean }): Promise<typeof botAdmin> => {
    const id = randomUUID().slice(0, 8)
    let bots = realImports(await readFile('lib/workspace-admin/bots.ts', 'utf8'))
    if (!guards.lock) {
      const access = mutate(await readFile('lib/workspace-access.ts', 'utf8'), LOCK_ANCHOR, ".limit(1)\n  if (!row || (admin", 'no-lock')
      await writeFile(join(mutantDir, `access-${id}.ts`), realImports(access))
      bots = mutate(bots, `from '${root}/lib/workspace-access'`, `from './access-${id}'`, 'no-lock')
    }
    if (!guards.cas) bots = mutate(bots, CAS_ANCHOR, CAS_MUTANT, 'no-cas')
    const botsFile = join(mutantDir, `bots-${id}.ts`)
    await writeFile(botsFile, bots)
    return await import(pathToFileURL(botsFile).href) as typeof botAdmin
  }
  // Backends that hold a lock on `table` and are themselves waiting on a lock (pg_locks, not query text).
  const waitersOn = async (table: string): Promise<number[]> => (await pool.query<{ pid: number }>(
    `select distinct l.pid from pg_locks l join pg_stat_activity a on a.pid = l.pid
     where l.relation = $1::regclass and l.granted and a.datname = current_database() and l.pid <> pg_backend_pid()
       and cardinality(pg_blocking_pids(l.pid)) > 0
       and exists (select 1 from pg_locks w where w.pid = l.pid and not w.granted)`, [table])).rows.map(row => row.pid)
  const waitUntil = async <T>(probe: () => Promise<T | undefined>, what: string): Promise<T> => {
    for (const deadline = Date.now() + 10_000; Date.now() < deadline; await new Promise(r => setTimeout(r, 20))) {
      const hit = await probe()
      if (hit !== undefined) return hit
    }
    throw new Error(`timed out waiting for ${what}`)
  }
  const settingsWriters = async () => (await waitersOn('workspace_settings')).length
  const conflictCode = (r: PromiseSettledResult<unknown>) => r.status === 'rejected' ? (r.reason as { code?: string }).code : 'ok'
  // A workspace whose settings row exists at version 1.
  const seedDefaults = async () => {
    const admin = await seedUser(pool, 'admin')
    const ws = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }])
    assert.equal((await botAdmin.saveBotDefaults(admin, ws.id, { defaultModel: 'claude' })).version, 1)
    return { admin, ws: ws.id }
  }
  // Hold the workspace_settings row so both saves reach their write before either can finish.
  const holdSettingsRow = async (ws: string) => {
    const holder = await pool.connect()
    await holder.query('begin')
    await holder.query('select 1 from workspace_settings where "workspaceId" = $1 for update', [ws])
    return { release: async () => { try { await holder.query('commit') } finally { holder.release() } } }
  }

  // Combined mutant: no workspace lock. Both saves read version 1 and both reach the UPDATE.
  const raceWithoutWorkspaceLock = async (mod: typeof botAdmin) => {
    const { admin, ws } = await seedDefaults()
    const held = await holdSettingsRow(ws)
    let saves: Promise<unknown>[] = []
    try {
      saves = [mod.saveBotDefaults(admin, ws, { defaultModel: 'codex', expectedVersion: 1 }), mod.saveBotDefaults(admin, ws, { defaultModel: 'mikka', expectedVersion: 1 })]
      saves.forEach(save => save.catch(() => undefined))
      await waitUntil(async () => await settingsWriters() >= 2 || undefined, 'both saves to wait at the UPDATE')
    } finally { await held.release() }
    const results = await Promise.allSettled(saves)
    return { codes: results.map(conflictCode).sort(), version: (await mod.botDefaultOptions(ws)).version }
  }

  await t.test('BE-15 mutant: without the workspace lock the CAS alone lets exactly one concurrent save win', async () => {
    const casOnly = await raceWithoutWorkspaceLock(await botsMutant({ lock: false, cas: true }))
    assert.deepEqual(casOnly.codes, ['botDefaultsConflict', 'ok'], 'CAS without the lock: exactly one 409')
    assert.equal(casOnly.version, 2)
    // Same scenario with the CAS removed too (mutant N2): both saves win, so the assertion above would fail.
    const neither = await raceWithoutWorkspaceLock(await botsMutant({ lock: false, cas: false }))
    assert.deepEqual(neither.codes, ['ok', 'ok'], 'the scenario must catch a non-atomic version check')
    assert.notDeepEqual(neither.codes, casOnly.codes)
  })

  // Normal path: save A holds the workspace lock (stuck behind the held settings row); does B wait on it?
  const secondSaveWaitsOnWorkspaceLock = async (mod: typeof botAdmin) => {
    const { admin, ws } = await seedDefaults()
    const held = await holdSettingsRow(ws)
    let saves: Promise<unknown>[] = []
    let waited: boolean
    try {
      const first = mod.saveBotDefaults(admin, ws, { defaultModel: 'codex', expectedVersion: 1 })
      first.catch(() => undefined)
      await waitUntil(async () => await settingsWriters() >= 1 || undefined, 'the first save to reach the UPDATE')
      const second = mod.saveBotDefaults(admin, ws, { defaultModel: 'mikka', expectedVersion: 1 })
      second.catch(() => undefined)
      saves = [first, second]
      // A is not waiting on mikka_workspaces (its UPDATE sits on another connection), so any waiter there is B.
      waited = await waitUntil(async () => {
        if ((await waitersOn('mikka_workspaces')).length > 0) return true
        if (await settingsWriters() >= 2) return false
        return undefined
      }, 'the second save to block')
    } finally { await held.release() }
    const results = await Promise.allSettled(saves)
    return { waited, codes: results.map(conflictCode) }
  }

  await t.test('BE-15 lock: a second save on the same workspace waits on the workspace row lock', async () => {
    const real = await secondSaveWaitsOnWorkspaceLock(botAdmin)
    assert.equal(real.waited, true, 'second save must hold a lock on mikka_workspaces and be blocked (pg_locks / pg_blocking_pids)')
    assert.deepEqual(real.codes, ['ok', 'botDefaultsConflict'], 'lock serialises the saves; the waiter then sees the new version')
    // The detector is not vacuous: with the lock removed it reports no workspace-lock wait.
    assert.equal((await secondSaveWaitsOnWorkspaceLock(await botsMutant({ lock: false, cas: true }))).waited, false)
  })

  await t.test('BE-15 stale form across sessions: save with an old version after another session saved is a 409', async () => {
    const { admin, ws } = await seedDefaults()
    const formA = await botAdmin.botDefaultOptions(ws)
    const formB = await botAdmin.botDefaultOptions(ws)
    assert.equal(formA.version, 1)
    assert.deepEqual(await botAdmin.saveBotDefaults(admin, ws, { defaultModel: 'codex', expectedVersion: formB.version }), { defaultModel: 'codex', defaultRepository: null, version: 2 })
    const stale = await botAdmin.saveBotDefaults(admin, ws, { defaultModel: 'mikka', expectedVersion: formA.version }).then(() => null, (error: unknown) => error as { code?: string; current?: unknown })
    assert.equal(stale?.code, 'botDefaultsConflict')
    assert.deepEqual(stale?.current, { defaultModel: 'codex', defaultRepository: null, version: 2 })
    assert.deepEqual(await botAdmin.workspaceBotDefaults(ws), { defaultModel: 'codex', defaultRepository: null }, 'stale form wrote nothing')
  })
})
