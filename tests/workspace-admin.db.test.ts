// Workspace settings › General / Members / Teams against a real PostgreSQL.
// Every destructive case seeds a second workspace and proves it is untouched.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { count, dbUrl, seedAgent, seedBot, seedIssue, seedProject, seedRun, seedTeam, seedTeamIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('workspace settings backend', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const { seedPersonalWorkspace } = await import('./support/workspace-admin-db')
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
    assert.deepEqual(await general.readWorkspaceGeneral(member, ws.id), { id: ws.id, name: ws.name, slug: ws.slug, icon: null, canEdit: false, canTransfer: false, personal: false })
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

  await t.test('transferWorkspaceOwnership: owner only, target active, member promoted, fallback when the owner left', async () => {
    const owner = await seedUser(pool, 'owner'), admin = await seedUser(pool, 'admin'), member = await seedUser(pool, 'member'), away = await seedUser(pool, 'away')
    const ws = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: admin, role: 'admin' }, { userId: member, role: 'member' }, { userId: away, role: 'member', status: 'suspended' }])
    const other = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: member, role: 'member' }])
    const ownerOf = async (id: string) => (await pool.query('select "userId" from mikka_workspaces where id=$1', [id])).rows[0].userId
    const roleOf = async (id: string, userId: string) => (await pool.query('select role from mikka_workspace_members where "workspaceId"=$1 and "userId"=$2', [id, userId])).rows[0].role
    assert.equal((await general.readWorkspaceGeneral(owner, ws.id)).canTransfer, true)
    assert.equal((await general.readWorkspaceGeneral(admin, ws.id)).canTransfer, false, 'another admin cannot while the owner is an active admin')
    assert.equal((await general.readWorkspaceGeneral(member, ws.id)).canTransfer, false)
    await rejects(general.transferWorkspaceOwnership(admin, ws.id, member), 'workspaceAccessDenied')
    await rejects(general.transferWorkspaceOwnership(member, ws.id, member), 'workspaceAccessDenied')
    await rejects(general.workspaceTransferTargets(admin, ws.id), 'workspaceAccessDenied')
    assert.deepEqual((await general.workspaceTransferTargets(owner, ws.id)).map(row => row.userId).sort(), [admin, member].sort(), 'active members other than the caller')
    await rejects(general.transferWorkspaceOwnership(owner, ws.id, owner), 'workspaceTransferTargetInvalid')
    await rejects(general.transferWorkspaceOwnership(owner, ws.id, away), 'workspaceTransferTargetInvalid')
    await rejects(general.transferWorkspaceOwnership(owner, ws.id, await seedUser(pool, 'stranger')), 'workspaceTransferTargetInvalid')

    const done = await general.transferWorkspaceOwnership(owner, ws.id, member)
    assert.equal(done.owner.userId, member)
    assert.equal(done.previousRole, 'member')
    assert.equal(await ownerOf(ws.id), member)
    assert.equal(await roleOf(ws.id, member), 'admin', 'the new owner is an admin')
    assert.equal(await roleOf(ws.id, owner), 'admin', 'the previous owner stays an admin')
    assert.equal(await ownerOf(other.id), owner, 'other workspace untouched')
    assert.equal(await roleOf(other.id, member), 'member')
    assert.equal((await general.readWorkspaceGeneral(owner, ws.id)).canTransfer, false)
    assert.equal((await general.readWorkspaceGeneral(member, ws.id)).canTransfer, true)

    // Once the owner is no longer an active admin, any admin can hand the workspace on.
    await pool.query('update mikka_workspace_members set status=\'suspended\' where "workspaceId"=$1 and "userId"=$2', [ws.id, member])
    assert.equal((await general.readWorkspaceGeneral(admin, ws.id)).canTransfer, true)
    await general.transferWorkspaceOwnership(admin, ws.id, owner)
    assert.equal(await ownerOf(ws.id), owner)
  })

  await t.test('a personal workspace has its 常规 but is neither transferred nor deleted (decision 2026-11-02-0203)', async () => {
    const owner = await seedUser(pool, 'personal-owner')
    const ws = { id: await seedPersonalWorkspace(pool, owner) }
    const read = await general.readWorkspaceGeneral(owner, ws.id)
    assert.equal(read.personal, true)
    assert.equal(read.canEdit, true, 'its own name, icon and address stay editable')
    assert.equal(read.canTransfer, false)
    assert.equal((await general.updateWorkspaceGeneral(owner, ws.id, { name: '林一的工作区' })).name, '林一的工作区')
    await rejects(general.deleteWorkspaceData(owner, ws.id, '林一的工作区'), 'workspacePersonalDelete')
    assert.equal(await count(pool, 'mikka_workspaces where id=$1', [ws.id]), 1)
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
      // Secrets, keys, policies, shares, payment, allowances, rules and tokens keyed by the workspace (gap M3).
      const key = randomUUID(), mailbox = randomUUID()
      for (const [text, values] of [
        [`insert into workspace_secrets (id,"workspaceId",name,kind,"scopeType","scopeRef",ciphertext,iv,"keyVersion","createdBy","updatedBy") values ($1,$2,'TOKEN','secret','workspace','','c','i',1,$3,$3)`, [randomUUID(), workspaceId, admin]],
        [`insert into workspace_e2b_keys ("workspaceId",ciphertext,iv,"keyVersion",last4,"createdBy","updatedBy") values ($1,'c','i',1,'abcd',$2,$2)`, [workspaceId, admin]],
        [`insert into workspace_app_policies ("workspaceId",app,access,"updatedBy") values ($1,'gmail','deny',$2)`, [workspaceId, admin]],
        ['insert into workspace_personal_policies ("workspaceId") values ($1)', [workspaceId]],
        ['insert into workspace_subscription_shares ("ownerId","workspaceId") values ($1,$2)', [member, workspaceId]],
        ['insert into workspace_credit_shares ("workspaceId","userId") values ($1,$2)', [workspaceId, member]],
        [`insert into model_api_keys (id,"ownerId",provider,protocol,ciphertext,iv,"keyVersion",last4) values ($1,$2,$3,'openai','c','i',1,'abcd')`, [key, member, `provider-${workspaceId}`]],
        ['insert into model_api_key_shares ("keyId","workspaceId") values ($1,$2)', [key, workspaceId]],
        ['insert into workspace_payment_designations ("workspaceId","userId") values ($1,$2)', [workspaceId, member]],
        ['insert into hosted_allowances ("workspaceId",remaining) values ($1,5)', [workspaceId]],
        ['insert into hosted_verifications ("workspaceId") values ($1)', [workspaceId]],
        ['insert into hosted_card_claims (fingerprint,"workspaceId") values ($1,$2)', [randomUUID(), workspaceId]],
        [`insert into execution_rules (id,"ownerId","workspaceId",place,harness,model,position) values ($1,$2,$3,'local','codex','gpt',0)`, [randomUUID(), member, workspaceId]],
        [`insert into personal_access_tokens (id,"userId","workspaceId",name,"tokenHash",hint) values ($1,$2,$3,'cli',$4,'abcd')`, [randomUUID(), member, workspaceId, randomUUID().replaceAll('-', '').repeat(2)]],
        [`insert into bot_model_choices ("ownerId","workspaceId","botKey") values ($1,$2,'k')`, [member, workspaceId]],
        // A run outside any bot that names the workspace's mailbox, without ON DELETE CASCADE.
        [`insert into session_mailboxes (id,"userId","workspaceId",kind,"sessionKey") values ($1,$2,$3,'run',$4)`, [mailbox, member, workspaceId, randomUUID()]],
        [`insert into agent_runs (id,"userId","agentId","mailboxId",status) values ($1,$2,$3,$4,'succeeded')`, [randomUUID(), member, agent, mailbox]],
      ] as const) await pool.query(text, [...values])
      return { bot, run, team, issue, project, mailbox, agent }
    }
    // Every main-database table keyed by a workspace, except those that stay on purpose (lib/workspace-rows.ts).
    const { KEPT_WITH_WORKSPACE, WORKSPACE_COLUMNS } = await import('../lib/workspace-rows')
    const keyed = (await pool.query<{ table: string; column: string }>(`select c.table_name as "table", c.column_name as "column" from information_schema.columns c
      join information_schema.tables t using (table_schema, table_name) where c.table_schema = current_schema() and t.table_type = 'BASE TABLE' and c.column_name = any($1::text[])`, [WORKSPACE_COLUMNS])).rows
      .filter(row => !KEPT_WITH_WORKSPACE.has(row.table))
    const rowsKeyedBy = async (workspaceId: string) => {
      const found: string[] = []
      for (const { table, column } of keyed) if (await count(pool, `"${table}" where "${column}"::text = $1`, [workspaceId])) found.push(table)
      return found.sort()
    }
    const doomed = await seed(ws.id)
    const kept = await seed(keep.id)
    // A newly tenant-keyed legacy row can have only its mailbox provenance.
    // Cleanup may follow that relation, but cannot sweep a bound foreign run.
    const foreignRun = randomUUID()
    await pool.query(`insert into agent_runs(id,"userId","agentId","mailboxId","workspaceId",status) values($1,$2,$3,$4,$5,'succeeded')`, [foreignRun, member, kept.agent, doomed.mailbox, keep.id])
    const { workspaceDeletionStatements } = await import('../lib/workspace-rows')
    const transaction = await pool.connect()
    try {
      await transaction.query('BEGIN')
      const cleanup = (await workspaceDeletionStatements(transaction, ws.id)).filter(statement => statement.table === 'agent_runs' && statement.text.includes('session_mailboxes'))
      assert.equal(cleanup.length, 1)
      for (const statement of cleanup) await transaction.query(statement.text, statement.values)
      assert.equal((await transaction.query('select id from agent_runs where "mailboxId"=$1 and "workspaceId" is null', [doomed.mailbox])).rowCount, 0)
      assert.equal((await transaction.query('select id from agent_runs where id=$1', [foreignRun])).rowCount, 1)
    } finally { await transaction.query('ROLLBACK'); transaction.release() }
    await pool.query('delete from agent_runs where id=$1', [foreignRun])
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
    // No row keyed by the deleted workspace is left; the other workspace keeps every one of its own.
    assert.deepEqual(await rowsKeyedBy(ws.id), [])
    const seeded = ['bot_model_choices', 'bots', 'conversations', 'execution_rules', 'hosted_allowances', 'hosted_verifications', 'model_api_key_shares', 'personal_access_tokens', 'session_mailboxes',
      'workspace_app_policies', 'workspace_credit_shares', 'workspace_e2b_keys', 'workspace_payment_designations', 'workspace_personal_policies', 'workspace_secrets', 'workspace_settings', 'workspace_subscription_shares']
    const left = await rowsKeyedBy(keep.id)
    assert.deepEqual(seeded.filter(table => !left.includes(table)), [], 'the other workspace is untouched')
    assert.equal(await count(pool, 'hosted_card_claims where "workspaceId"=$1', [ws.id]), 1, 'a card claim is never released')
    // Its audit log stays until the retention job expires it, from the recorded deletion time.
    assert.equal(await count(pool, 'workspace_deletions where id=$1 and "deletedAt" > now() - interval \'1 minute\'', [ws.id]), 1)
    assert.equal(await count(pool, 'workspace_deletions where id=$1', [keep.id]), 0)
    assert.equal(await count(pool, 'model_api_keys where "ownerId"=$1', [member]), 2, 'the API keys themselves are the member\'s')
  })


  await t.test('workspace deletion counts persisted tenant tasks without Team links and never follows a foreign link', async () => {
    const admin = await seedUser(pool, 'ungrouped-admin'), member = await seedUser(pool, 'ungrouped-member')
    const workspace = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'member' }], 'Ungrouped tenant')
    const other = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }], 'Other tenant')
    const first = await seedIssue(pool, admin, workspace.id), second = await seedIssue(pool, member, workspace.id)
    const foreign = await seedIssue(pool, admin, other.id), personal = await seedIssue(pool, admin)
    const pending = randomUUID()
    await pool.query('INSERT INTO issues(id,"userId",title,content,status,priority) VALUES($1,$2,\'Unresolved\',\'{"type":"doc"}\',\'todo\',\'normal\')', [pending, admin])
    const team = await seedTeam(pool, workspace.id, admin)
    // A historical cross-database link cannot change the task's persisted tenant.
    await pool.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)', [foreign, team.id, workspace.id, admin])
    const ids = [first, second, foreign, personal, pending]
    for (const issueId of ids) {
      await pool.query('INSERT INTO issue_documents("issueId","userId",state) SELECT id,"userId",$2 FROM issues WHERE id=$1', [issueId, `document-${issueId}`])
      await pool.query('INSERT INTO issue_members("issueId","userId","memberId") SELECT id,"userId",$2 FROM issues WHERE id=$1', [issueId, admin])
      await pool.query(`INSERT INTO issue_versions(id,"issueId","userId",revision,title,content,status,priority)
        SELECT $1,id,"userId",revision,title,content,status,priority FROM issues WHERE id=$2`, [randomUUID(), issueId])
    }
    assert.equal(await count(pool, 'mikka_team_issues WHERE "issueId"=ANY($1::uuid[])', [[first, second]]), 0)
    assert.deepEqual(await general.workspaceDeletionImpact(admin, workspace.id), { bots: 0, tasks: 2, teams: 1, purchasedPoints: 0 })
    await rejects(general.workspaceDeletionImpact(member, workspace.id), 'workspaceAccessDenied')
    await rejects(general.deleteWorkspaceData(member, workspace.id, workspace.name), 'workspaceAccessDenied')
    await rejects(general.deleteWorkspaceData(admin, workspace.id, 'wrong name'), 'workspaceDeleteNameMismatch')
    assert.equal(await count(pool, 'issues WHERE id=ANY($1::uuid[])', [ids]), 5, 'refused deletion changes no task')
    assert.equal(await count(pool, 'issue_documents WHERE "issueId"=ANY($1::uuid[])', [ids]), 5)

    const deleted = await general.deleteWorkspaceData(admin, workspace.id, workspace.name)
    assert.deepEqual(deleted.deleted, { bots: 0, threads: 0, tasks: 2, projects: 0, teams: 1, invitations: 0, members: 2 })
    for (const table of ['issues', 'issue_documents', 'issue_versions', 'issue_members']) {
      const column = table === 'issues' ? 'id' : '"issueId"'
      assert.equal(await count(pool, `${table} WHERE ${column}=ANY($1::uuid[])`, [[first, second]]), 0, 'all ungrouped tenant tasks and history are removed')
      assert.equal(await count(pool, `${table} WHERE ${column}=ANY($1::uuid[])`, [[foreign, personal, pending]]), 3, 'other and unresolved tenants are untouched')
    }
    assert.equal(await count(pool, 'issues WHERE "workspaceId"=$1', [workspace.id]), 0)
    assert.equal(await count(pool, 'issues WHERE id=$1 AND "workspaceId"=$2 AND "ownershipState"=\'bound\'', [foreign, other.id]), 1)
    assert.equal(await count(pool, 'issues WHERE id=$1 AND "workspaceId" IS NULL AND "ownershipState"=\'pending\'', [pending]), 1)
    assert.equal(await count(pool, 'mikka_workspaces WHERE id=$1', [other.id]), 1)
    assert.equal(await count(pool, 'mikka_team_issues WHERE "workspaceId"=$1', [workspace.id]), 0)
    assert.equal(await count(pool, 'workspace_deletions WHERE id=$1', [workspace.id]), 1)
  })

  await t.test('removeMember: guards, immediate access loss, bot transfer', async () => {
    const admin = await seedUser(pool, 'admin'), leaving = await seedUser(pool, 'leaving'), heir = await seedUser(pool, 'heir')
    const ws = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: leaving, role: 'member' }, { userId: heir, role: 'member' }])
    const elsewhere = await seedWorkspace(pool, leaving, [{ userId: leaving, role: 'admin' }])
    const team = await seedTeam(pool, ws.id, admin)
    await pool.query('insert into mikka_team_members ("teamId","userId") values ($1,$2)', [team.id, leaving])
    const bot = await seedBot(pool, ws.id, leaving, 'Helper')
    await pool.query('update resource_access_policies set visibility=\'shared\' where kind=\'bot\' and id=$1', [bot])
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
    assert.equal(await count(pool, 'agent_kit_heads where bot_id=$1', [bot]), 0, 'the previous Owner head is detached from the live Bot')
    assert.equal(await count(pool, 'agent_kit_heads where detached_bot_id=$1 and owner_id=$2 and detached_workspace_id=$3', [bot, leaving, ws.id]), 1)
    assert.equal(await count(pool, 'agent_kit_versions where id=$1 and owner_id=$2', [versionId, leaving]), 1, 'immutable private version history is retained')
    assert.equal(await count(pool, 'agent_kit_versions where bot_key=$1 and owner_id=$2', [bot, heir]), 0, 'the recipient gets no old Owner definition')
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
    await pool.query('update resource_access_policies set visibility=\'shared\' where kind=\'bot\' and id=$1', [bot])
    // The bot's hidden cloud runtime agent, with a finished thread on it.
    const device = randomUUID(), agent = randomUUID(), repo = randomUUID()
    await pool.query(`insert into devices (id,"ownerId",name,kind) values ($1,$2,'Cloud computer','cloud')`, [device, target])
    await pool.query(`insert into device_repos (id,"deviceId","userId","repoPath","baseBranch") values ($1,$2,$3,$4,'main')`, [repo, device, target, `/home/user/.mikka/bot-workspaces/${bot}`])
    await pool.query(`insert into agents (id,"userId",harness,name,"deviceId") values ($1,$2,'codex',$3,$4)`, [agent, target, `Cloud codex ${bot}`, device])
    await pool.query(`insert into bot_cloud_runtimes ("botId","workspaceId","ownerId",harness,"agentId","repoId") values ($1,$2,$3,'codex',$4,$5)`, [bot, ws.id, target, agent, repo])
    await seedRun(pool, { userId: target, agentId: agent, botId: bot, status: 'completed' })
    const { workspaceDb } = await import('../lib/workspace-db')
    const moved = await workspaceDb.transaction(tx => members.transferOnSuspend(tx, ws.id, target, heir))
    assert.deepEqual(moved, { bots: 1 })
    assert.equal(await count(pool, 'bots where id=$1 and "ownerId"=$2', [bot, heir]), 1)
    assert.equal(await count(pool, 'bot_cloud_runtimes where "botId"=$1', [bot]), 0, 'the runtime is made again for the new owner')
    assert.equal(await count(pool, 'agent_runs where "agentId"=$1', [agent]), 1, 'the thread history stays')
    assert.equal(await count(pool, 'agents where "userId"=$1 and lower(name)=lower($2)', [target, `Cloud codex ${bot}`]), 0, 'the old agent gives up the runtime name, so the bot can come back to its owner')
  })

  await t.test('Private Bot transfer requires its Owner and exact revision; old Thread, machine and Agent history remain private', async () => {
    const admin = await seedUser(pool, 'private-admin'), owner = await seedUser(pool, 'private-owner'), heir = await seedUser(pool, 'private-heir')
    const ws = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: owner, role: 'member' }, { userId: heir, role: 'member' }])
    const bot = await seedBot(pool, ws.id, owner, 'Private helper'), agentId = await seedAgent(pool, owner)
    const run = await seedRun(pool, { userId: owner, agentId, workspaceId: ws.id, botId: bot })
    const deviceId = randomUUID()
    await pool.query('insert into devices(id,"ownerId",name,kind) values($1,$2,\'Private computer\',\'local\')', [deviceId, owner])
    const { AgentKitStore } = await import('../lib/agent-kit/store')
    const { DEFAULT_AGENT_DEFINITION } = await import('../lib/agent-kit/builtin')
    const kit = new AgentKitStore(pool)
    const version = await kit.active({ ownerId: owner, botId: bot, workspaceId: ws.id }, DEFAULT_AGENT_DEFINITION)
    await pool.query('update bots set "archivedAt"=now() where id=$1', [bot])
    assert.deepEqual(await members.archivedBots(admin, ws.id), [])
    await rejects(members.takeOverBot(admin, ws.id, bot), 'botNotFound')
    const revision = async () => Number((await pool.query('select revision from resource_access_policies where kind=\'bot\' and id=$1', [bot])).rows[0].revision)
    await rejects(members.transferOwnedBot(admin, ws.id, bot, heir, { expectedRevision: await revision(), confirmPrivateTransfer: true }), 'botNotFound')
    await rejects(members.transferOwnedBot(owner, ws.id, bot, heir, { expectedRevision: await revision(), confirmPrivateTransfer: false }), 'validationGeneric')
    await rejects(members.transferOwnedBot(owner, ws.id, bot, heir, { expectedRevision: (await revision()) + 1, confirmPrivateTransfer: true }), 'botNotFound')
    assert.deepEqual(await members.transferOwnedBot(owner, ws.id, bot, heir, { expectedRevision: await revision(), confirmPrivateTransfer: true }), { bots: 1 })
    assert.equal(await count(pool, 'agent_runs where id=$1 and "userId"=$2', [run, owner]), 1)
    assert.equal(await count(pool, 'devices where id=$1 and "ownerId"=$2', [deviceId, owner]), 1)
    assert.equal(await count(pool, 'agent_kit_versions where id=$1 and owner_id=$2', [version.id, owner]), 1)
    const historyAccess = await pool.query('select mikka_resource_acl_allowed(\'account\',$1,$3,\'thread\',$4,\'canReadContent\') as original, mikka_resource_acl_allowed(\'account\',$2,$3,\'thread\',$4,\'canReadContent\') as recipient', [owner, heir, ws.id, run])
    assert.deepEqual(historyAccess.rows, [{ original: true, recipient: false }])
    const fresh = await kit.active({ ownerId: heir, botId: bot, workspaceId: ws.id }, DEFAULT_AGENT_DEFINITION)
    assert.notEqual(fresh.id, version.id)
    assert.deepEqual((await kit.history({ ownerId: heir, botId: bot, workspaceId: ws.id })).map(row => row.id), [fresh.id])
    assert.equal(await count(pool, 'resource_access_events where "resourceKind"=\'bot\' and "resourceId"=$1 and "actorId"=$2 and source=\'owner_bot_transfer\' and detail->>\'previousOwnerId\'=$2 and "ownerId"=$3', [bot, owner, heir]), 1)
  })

  await t.test('member departure permanently revokes tenant PAT and grants, stops delegated work, and keeps personal devices and other tenants', async () => {
    const admin = await seedUser(pool, 'revoke-admin'), leaving = await seedUser(pool, 'revoke-leaving'), peer = await seedUser(pool, 'revoke-peer')
    const ws = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: leaving, role: 'member' }, { userId: peer, role: 'member' }])
    const other = await seedWorkspace(pool, leaving, [{ userId: leaving, role: 'admin' }])
    const privateBot = await seedBot(pool, ws.id, leaving), device = randomUUID(), token = randomUUID(), foreignToken = randomUUID()
    await pool.query('insert into devices(id,"ownerId",name,kind) values($1,$2,\'Personal local\',\'local\')', [device, leaving])
    for (const [id, workspaceId] of [[token, ws.id], [foreignToken, other.id]]) await pool.query('insert into personal_access_tokens(id,"userId","workspaceId",name,"tokenHash",hint) values($1,$2,$3,\'fixture\',$4,\'test\')', [id, leaving, workspaceId, randomUUID().replaceAll('-', '').repeat(2)])
    const agentId = await seedAgent(pool, admin), task = await seedIssue(pool, admin, ws.id)
    const delegated = await seedRun(pool, { userId: admin, agentId, workspaceId: ws.id, issueId: task, status: 'queued' })
    await pool.query('update resource_access_policies set visibility=\'private\' where kind=\'thread\' and id=$1', [delegated])
    await pool.query('insert into resource_access_grants("resourceKind","resourceId","subjectKind","subjectId",capabilities) values(\'thread\',$1,\'account\',$2,$3)', [delegated, leaving, ['canReadContent', 'canSteer']])
    await pool.query('update agent_runs set "agentDefinition"=$2 where id=$1', [delegated, { executionIdentity: { actor: leaving } }])
    await members.removeMember(admin, ws.id, leaving, peer)
    assert.equal(await count(pool, 'bots where id=$1 and "ownerId"=$2 and "archivedAt" is not null', [privateBot, leaving]), 1, 'a departure does not authorize private Bot takeover')
    assert.equal(await count(pool, 'devices where id=$1 and "ownerId"=$2', [device, leaving]), 1)
    assert.equal(await count(pool, 'resource_access_grants where "resourceKind"=\'thread\' and "resourceId"=$1 and "subjectId"=$2', [delegated, leaving]), 0)
    assert.equal(await count(pool, 'agent_runs where id=$1 and status=\'stopped\' and "stopRequestedAt" is not null', [delegated]), 1)
    assert.equal(await count(pool, 'personal_access_tokens where id=$1 and "revokedAt" is not null', [token]), 1)
    assert.equal(await count(pool, 'personal_access_tokens where id=$1 and "revokedAt" is null', [foreignToken]), 1)
    await pool.query('insert into mikka_workspace_members("workspaceId","userId",name,email,role,status) values($1,$2,$2,$3,\'member\',\'active\')', [ws.id, leaving, `${leaving}@example.invalid`])
    await members.restoreReturningMember(ws.id, leaving)
    assert.equal(await count(pool, 'personal_access_tokens where id=$1 and "revokedAt" is not null', [token]), 1, 'rejoining does not resurrect an old PAT')
    assert.equal(await count(pool, 'resource_access_grants where "resourceKind"=\'thread\' and "resourceId"=$1 and "subjectId"=$2', [delegated, leaving]), 0)
  })

  await t.test('deleting a human Session durably stops its admitted collaborative turn without refunding reserved compute', async () => {
    const owner = await seedUser(pool, 'session-owner'), actor = await seedUser(pool, 'session-actor')
    const ws = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: actor, role: 'member' }])
    const agentId = await seedAgent(pool, owner), issueId = await seedIssue(pool, owner, ws.id)
    const source = await seedRun(pool, { userId: owner, agentId, workspaceId: ws.id, issueId })
    await pool.query('update resource_access_policies set visibility=\'shared\' where kind=\'thread\' and id=$1', [source])
    const revision = (await pool.query('select revision from resource_access_policies where kind=\'thread\' and id=$1', [source])).rows[0].revision
    const runId = await seedRun(pool, { userId: owner, agentId, workspaceId: ws.id, issueId, status: 'queued' })
    const sessionId = randomUUID(), grantId = randomUUID(), receiptId = randomUUID()
    await pool.query('insert into "session"(id,"userId",token,"expiresAt","createdAt","updatedAt") values($1,$2,$3,now()+interval \'1 hour\',now(),now())', [sessionId, actor, randomUUID()])
    await pool.query(`insert into thread_execution_grants(id,"workspaceId","threadId","ownerId","actorId","policyRevision","credentialId","credentialOwnerId",model,harness,"computeOwnerId","totalComputeSeconds","maxTurnSeconds","reservedComputeSeconds","expiresAt")
      values($1,$2,$3,$4,$5,$6,$7,$4,'fixture','codex',$4,600,300,90,now()+interval '1 hour')`, [grantId, ws.id, source, owner, actor, revision, randomUUID()])
    await pool.query(`insert into thread_execution_authorizations(id,"grantId","grantRevision","requestId","requestFingerprint","workspaceId","threadId","sourceRunId","ownerId","actorId","sessionId","reservedSeconds","expiresAt","runId")
      values($1,$2,1,$3,$4,$5,$6,$6,$7,$8,$9,90,now()+interval '1 hour',$10)`, [receiptId, grantId, randomUUID(), 'a'.repeat(64), ws.id, source, owner, actor, sessionId, runId])
    await pool.query('update agent_runs set "agentDefinition"=$2 where id=$1', [runId, { executionIdentity: { version: 2, actor, collaborationAuthorizationId: receiptId } }])
    await pool.query('delete from "session" where id=$1', [sessionId])
    assert.equal(await count(pool, 'resource_session_revocations where "sessionId"=$1 and "deliveredAt" is null', [sessionId]), 1)
    const { expireResourceAuthority } = await import('../lib/resource-access/lifecycle')
    await expireResourceAuthority(actor)
    assert.equal(await count(pool, 'agent_runs where id=$1 and status=\'stopped\' and "stopRequestedAt" is not null', [runId]), 1)
    assert.equal(await count(pool, 'thread_execution_authorizations where id=$1 and "releasedAt" is not null', [receiptId]), 1)
    assert.equal(await count(pool, 'resource_session_revocations where "sessionId"=$1 and "deliveredAt" is not null', [sessionId]), 1)
    assert.equal((await pool.query('select "reservedComputeSeconds" from thread_execution_grants where id=$1', [grantId])).rows[0].reservedComputeSeconds, 90)
    assert.equal((await expireResourceAuthority(actor)).stoppedRuns, 0, 'a replay is idempotent')
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

  await t.test('bot defaults require personal Git authority and private Bot activity remains private', async () => {
    const admin = await seedUser(pool, 'admin'), member = await seedUser(pool, 'member'), outsider = await seedUser(pool, 'outsider')
    const ws = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'member' }])
    const other = await seedWorkspace(pool, outsider, [{ userId: outsider, role: 'admin' }])
    const repo = `acme/${randomUUID().slice(0, 8)}`, foreignRepo = `other/${randomUUID().slice(0, 8)}`
    await pool.query('insert into github_repository_installations ("userId","remoteKey","githubAccountId","installationId","repositoryId") values ($1,$2,\'1\',1,1)', [member, repo])
    await pool.query('insert into github_repository_installations ("userId","remoteKey","githubAccountId","installationId","repositoryId") values ($1,$2,\'2\',2,2)', [outsider, foreignRepo])
    const options = await botAdmin.botDefaultOptions(ws.id, member)
    assert.deepEqual(options.models, ['mikka', 'codex', 'claude'])
    assert.deepEqual(options.repositories, [repo])
    assert.equal(options.defaultModel, null)
    await rejects(botAdmin.saveBotDefaults(member, ws.id, { defaultModel: 'codex' }), 'workspaceAccessDenied')
    await rejects(botAdmin.saveBotDefaults(admin, ws.id, { defaultRepository: foreignRepo }), 'botDefaultRepositoryUnavailable')
    await assert.rejects(botAdmin.saveBotDefaults(admin, ws.id, { defaultModel: 'gpt-x' as never }))
    assert.deepEqual((await botAdmin.botDefaultOptions(ws.id,admin)).repositories, [])
    await rejects(botAdmin.saveBotDefaults(admin,ws.id,{defaultRepository:repo}),'botDefaultRepositoryUnavailable')
    await pool.query('insert into github_repository_installations ("userId","remoteKey","githubAccountId","installationId","repositoryId") values ($1,$2,\'3\',3,3)', [admin,repo])
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
    const listed = await botAdmin.workspaceBots(ws.id,member)
    assert.deepEqual(listed.map(bot => [bot.id, bot.status, bot.runningThreads, bot.ownerName]), [[busy, 'running', 2, member]])
    assert.deepEqual((await botAdmin.workspaceBots(ws.id,admin)).map(bot=>bot.id),[idle])
    await pool.query("UPDATE resource_access_policies SET visibility='shared' WHERE kind='bot' AND id=$1",[busy])
    const shared = (await botAdmin.workspaceBots(ws.id,admin)).find(bot=>bot.id===busy)
    assert.equal(shared?.runningThreads,0,'sharing a Bot does not reveal its owner’s private execution activity')
  })
})
