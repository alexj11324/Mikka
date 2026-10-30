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

  await t.test('readWorkspaceGeneral and workspaceDeletionImpact: members read values, only admins see the impact', async () => {
    const admin = await seedUser(pool, 'admin'), member = await seedUser(pool, 'member'), stranger = await seedUser(pool, 'stranger')
    const ws = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'member' }])
    const other = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }])
    assert.deepEqual(await general.readWorkspaceGeneral(member, ws.id), { id: ws.id, name: ws.name, slug: ws.slug, icon: null, canEdit: false })
    assert.equal((await general.readWorkspaceGeneral(admin, ws.id)).canEdit, true)
    await rejects(general.readWorkspaceGeneral(stranger, ws.id), 'workspaceAccessDenied')
    await seedBot(pool, ws.id, admin); await seedBot(pool, ws.id, member); await seedBot(pool, other.id, admin)
    const team = await seedTeam(pool, ws.id, admin)
    await seedTeamIssue(pool, ws.id, team.id, admin); await seedTeamIssue(pool, ws.id, team.id, admin)
    await pool.query(`insert into workspace_credit_grants (id,"workspaceId",bucket,points,reason,"externalId") values ($1,$2,'purchased',1200,'pack',$3),($4,$2,'plan',5000,'invoice',$5),($6,$7,'purchased',99,'pack',$8)`,
      [randomUUID(), ws.id, `x-${randomUUID()}`, randomUUID(), `y-${randomUUID()}`, randomUUID(), other.id, `z-${randomUUID()}`])
    assert.deepEqual(await general.workspaceDeletionImpact(admin, ws.id), { bots: 2, tasks: 2, teams: 1, purchasedPoints: 1200 })
    await rejects(general.workspaceDeletionImpact(member, ws.id), 'workspaceAccessDenied')
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
    assert.deepEqual({ removed: removed.removed, transferred: removed.transferred }, { removed: true, transferred: { bots: 1 } })
    assert.ok(removed.label)
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
    assert.deepEqual(await botAdmin.saveBotDefaults(admin, ws.id, { defaultModel: 'codex', defaultRepository: repo }), { defaultModel: 'codex', defaultRepository: repo })
    assert.deepEqual(await botAdmin.saveBotDefaults(admin, ws.id, { defaultRepository: null }), { defaultModel: 'codex', defaultRepository: null })
    assert.deepEqual(await botAdmin.workspaceBotDefaults(other.id), { defaultModel: null, defaultRepository: null }, 'defaults are per workspace')

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
})
