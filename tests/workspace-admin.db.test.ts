// Workspace settings › General / Members / Teams against a real PostgreSQL.
// Every destructive case seeds a second workspace and proves it is untouched.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { count, dbUrl, seedAgent, seedBot, seedIssue, seedProject, seedRun, seedTeam, seedTeamIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'

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
    const ws = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
    await pool.query(`UPDATE mikka_workspaces SET kind='personal' WHERE id=$1`, [ws.id])
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
