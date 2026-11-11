import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { dbUrl, seedAgent, seedBot, seedIssue, seedRun, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { provisionWorkspacePlan } from '../lib/governance/provisioning'

let principal: { id: string; workspaceId?: string } | null = null
mock.module('@/lib/auth', { namedExports: { auth: { api: { getSession: async (options: { query?: { disableCookieCache?: boolean } }) => {
  assert.equal(options.query?.disableCookieCache, true, 'governance always asks for a fresh session')
  return principal ? { user: { id: principal.id, name: principal.id, email: `${principal.id}@example.invalid` }, session: { id: 'fixture-session' }, ...(principal.workspaceId ? { tokenWorkspaceId: principal.workspaceId } : {}) } : null
} } } } })
// Only the external scheduler transport is replaced; every ACL, entitlement,
// transaction, policy change, usage read and audit write uses real PostgreSQL.
mock.module('@/lib/due-timer', { namedExports: { armDueTimerAfterCommit: () => {} } })

test('Team governance HTTP handlers enforce actual entitlements and workspace boundaries', { skip: !dbUrl, timeout: 120_000 }, async t => {
  const previousEdition = process.env.MIKKA_EDITION
  process.env.MIKKA_EDITION = 'cloud'
  const [{ pool }, { workspacePool }, governance, usage] = await Promise.all([
    import('../lib/db'), import('../lib/workspace-db'),
    import('../app/api/workspaces/[workspaceId]/governance/route'), import('../app/api/workspaces/[workspaceId]/governance/usage/route'),
  ])
  // This test process owns both real pools. One connection each proves that
  // pinned workspace reads compose without a hidden secondary checkout.
  pool.options.max = 1
  workspacePool.options.max = 1
  const owner = await seedUser(pool, 'team-owner'), member = await seedUser(pool, 'team-member'), stranger = await seedUser(pool, 'team-stranger')
  const first = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: member, role: 'member' }])
  const second = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  await seedBot(pool, first.id, owner)
  t.after(async () => {
    principal = null
    if (previousEdition === undefined) delete process.env.MIKKA_EDITION
    else process.env.MIKKA_EDITION = previousEdition
    await pool.query('delete from hosted_usage where "workspaceId"=any($1::uuid[])', [[first.id, second.id]])
    await pool.query('delete from workspace_computer_policies where "workspaceId"=any($1::uuid[])', [[first.id, second.id]])
    await pool.query('delete from bots where "workspaceId"=any($1::uuid[])', [[first.id, second.id]])
    await pool.query('delete from mikka_workspaces where id=any($1::uuid[])', [[first.id, second.id]])
    await pool.query('delete from "user" where id=any($1::text[])', [[owner, member, stranger]])
    await Promise.all([pool.end(), workspacePool.end()])
  })
  const request = (workspaceId: string, method = 'GET', body?: unknown, query = '') => new Request(`https://mikka.test/api/workspaces/${workspaceId}/governance${query}`, { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) })
  const context = (workspaceId: string) => ({ params: Promise.resolve({ workspaceId }) })
  const get = (id = first.id) => governance.GET(request(id), context(id))
  const post = (body: unknown, id = first.id) => governance.POST(request(id, 'POST', body), context(id))
  const report = (query = '', id = first.id) => usage.GET(request(id, 'GET', undefined, `/usage${query}`), context(id))
  const grant = (workspaceId: string, plan: 'free' | 'pro', expectedPlan: 'free' | 'pro') => provisionWorkspacePlan(pool, { workspaceId, plan, expectedPlan, source: 'cloud', seatLimit: plan === 'pro' ? 20 : null, expiresAt: null, reason: plan === 'pro' ? 'evaluation' : 'downgrade', operator: 'operator-fixture' }, { mode: 'cloud', apply: true })

  await t.test('Free membership remains usable and request fields cannot upgrade a plan', async () => {
    principal = { id: owner }
    const response = await get()
    assert.equal(response.status, 200)
    const summary = await response.json()
    assert.equal(summary.edition, 'team_free')
    assert.equal(summary.activeHumans, 2)
    assert.equal(summary.activeHumanLimit, null)
    assert.equal((await post({ action: 'grant', plan: 'pro' })).status, 400)
    assert.equal((await post({ action: 'save', template: { name: 'Read only', rules: { approvalMode: 'read_only' } } })).status, 409)
    assert.equal((await report()).status, 409)
    assert.equal((await pool.query('select count(*)::int as n from mikka_workspace_entitlements where "workspaceId"=$1', [first.id])).rows[0].n, 0)
  })

  await t.test('Pro templates mutate the real policy while preserving unrelated permissions', async () => {
    await grant(first.id, 'pro', 'free')
    await grant(second.id, 'pro', 'free')
    principal = { id: owner }
    const summary = await (await get()).json()
    assert.equal(summary.hostedMaxInFlight, 32)
    assert.equal(summary.approvalTemplates, true)
    const saved = await post({ action: 'save', template: { name: 'Read only', rules: { approvalMode: 'read_only' } } })
    assert.equal(saved.status, 200)
    const { id } = await saved.json()
    assert.equal((await post({ action: 'apply', templateId: id }, second.id)).status, 404)
    assert.equal((await post({ action: 'save', template: { name: 'Forged', rules: { permissions: { computer_use: 'allow' } } } })).status, 400)
    await pool.query('insert into workspace_computer_policies ("workspaceId",permission) values($1,\'deny\') on conflict ("workspaceId") do update set permission=\'deny\'', [first.id])
    const before = (await pool.query('select external_write_permissions,external_write_policy_version from workspace_computer_policies where "workspaceId"=$1', [first.id])).rows[0]
    assert.equal((await post({ action: 'apply', templateId: id })).status, 200)
    const applied = (await pool.query('select permission,cli_run_policy,external_write_permissions,external_write_policy_version from workspace_computer_policies where "workspaceId"=$1', [first.id])).rows[0]
    assert.equal(applied.permission, 'deny')
    assert.deepEqual(applied.cli_run_policy, { approvalMode: 'read_only' })
    assert.deepEqual({ external_write_permissions: applied.external_write_permissions, external_write_policy_version: applied.external_write_policy_version }, before)
    assert.equal((await pool.query('select count(*)::int as n from workspace_audit_events where "workspaceId"=$1 and action=\'agent.policy_changed\' and "targetId"=$2', [first.id, id])).rows[0].n, 1)
    principal = { id: member }
    assert.equal((await post({ action: 'delete', templateId: id })).status, 403)
    principal = { id: owner }
    await grant(first.id, 'free', 'pro')
    assert.equal((await post({ action: 'apply', templateId: id })).status, 409)
    assert.equal((await pool.query('select count(*)::int as n from mikka_governance_approval_templates where id=$1', [id])).rows[0].n, 1, 'downgrade retains saved configuration')
    await grant(first.id, 'pro', 'free')
    assert.equal((await post({ action: 'delete', templateId: id })).status, 200)
  })

  await t.test('usage and CSV contain only this workspace actual hosted costs, never BYOS charges', async () => {
    principal = { id: owner }
    await pool.query(`insert into hosted_usage (id,"workspaceId",model,state,"costMicroUsd","freeMicroUsd","purchasedMicroUsd","inputTokens","outputTokens","createdAt") values
      ($1,$2,'=literal-model','settled',123,23,100,50,70,'2026-11-07T12:00:00Z'),
      ($3,$4,'other-workspace-secret','settled',9999,0,9999,99,99,'2026-11-07T12:00:00Z'),
      ($5,$2,'unsettled','pending',null,0,0,0,0,'2026-11-07T12:00:00Z')`, [randomUUID(), first.id, randomUUID(), second.id, randomUUID()])
    const agentId = await seedAgent(pool, owner)
    const runId = await seedRun(pool, { userId: owner, agentId, workspaceId: first.id, status: 'succeeded' })
    assert.equal((await (await get()).json()).activeHumans, 2, 'Bots, Agents and runs do not consume human seats')
    await pool.query('update agent_runs set "createdAt"=\'2026-11-07T12:00:00Z\' where id=$1', [runId])
    const response = await report('?from=2026-11-07&to=2026-11-07')
    assert.equal(response.status, 200)
    const data = await response.json()
    // This row shape changed when the report gained per-dimension fields, so the
    // literal below gained them too. Each addition states a fact the fixture
    // proves rather than a number moved to match output:
    //   memberId/repository - the default report is not subdivided, so both are
    //     null; a caller asks for one with groupBy.
    //   unknownRequests - none of these settled rows lacked a provider cost.
    //   cacheReadTokens/cacheWriteTokens - the fixture inserted no cache figures,
    //     so they are null, NOT "0": absent means uncollected. cacheCollectedRequests
    //     reports 0, which is how a reader tells this apart from a real zero.
    assert.deepEqual(data.hosted, [{
      day: '2026-11-07', model: '=literal-model', memberId: null, repository: null, requests: 1, unknownRequests: 0,
      inputTokens: '50', outputTokens: '70', cacheReadTokens: null, cacheWriteTokens: null, cacheCollectedRequests: 0,
      costMicroUsd: '123', freeMicroUsd: '23', purchasedMicroUsd: '100',
    }])
    assert.deepEqual(data.runs, [{ status: 'succeeded', count: 1 }])
    // A new client learns the available dimensions from the response itself, so a
    // dimension added here is discoverable without reading this source.
    assert.deepEqual(data.availableGroupBy, ['day', 'model', 'member', 'repository'])
    assert.equal(data.groupBy, null, 'an omitted groupBy keeps the unsubdivided shape')
    assert.equal((await report('?from=2026-11-07&to=2026-11-07&groupBy=bogus')).status, 400, 'an unknown dimension is refused, never guessed')
    const csvResponse = await report('?from=2026-11-07&to=2026-11-07&format=csv')
    assert.equal(csvResponse.status, 200)
    assert.equal(csvResponse.headers.get('cache-control'), 'private, no-store')
    const csv = await csvResponse.text()
    assert.ok(csv.includes('"\'=literal-model"'))
    assert.ok(!csv.includes('other-workspace-secret') && !csv.includes('unsettled'))
    assert.equal((await pool.query('select count(*)::int as n from workspace_audit_outbox where "workspaceId"=$1 and payload->>\'action\'=\'audit.exported\'', [first.id])).rows[0].n, 1)
    assert.equal((await pool.query('select count(*)::int as n from workspace_credit_grants where "workspaceId"=$1', [first.id])).rows[0].n, 0)
    assert.equal((await report('?from=2026-02-30')).status, 400)
    assert.equal((await report('?from=2025-01-01&to=2026-11-07')).status, 400)
    await pool.query('delete from agent_runs where id=$1', [runId])
    await pool.query('delete from agents where id=$1', [agentId])
  })

  await t.test('cache figures distinguish not-collected from zero, and the subdivisions split the same ledger', async () => {
    principal = { id: owner }
    // One settled call that reported cache, one that reported none, and one whose
    // repository attribution never completed. All three are real spend.
    await pool.query(`insert into hosted_usage (id,"workspaceId",model,state,"costMicroUsd","freeMicroUsd","purchasedMicroUsd","inputTokens","outputTokens","cacheReadTokens","cacheWriteTokens","actorId","createdAt") values
      ($1,$2,'cached','settled',100,0,100,1000,10,800,50,'alice','2026-11-08T12:00:00Z'),
      ($3,$2,'uncached','settled',50,0,50,400,10,null,null,'bob','2026-11-08T12:00:00Z'),
      ($4,$2,'plain','settled',25,0,25,100,10,0,0,'alice','2026-11-08T12:00:00Z')`,
      [randomUUID(), first.id, randomUUID(), randomUUID()])
    const read = async (query: string) => (await report(`?from=2026-11-08&to=2026-11-08${query}`)).json()
    const byModel = new Map(((await read('')).hosted as Array<Record<string, unknown>>).map(row => [row.model as string, row]))

    // Collected zero and never collected are different facts and must stay different.
    assert.equal(byModel.get('cached')!.cacheReadTokens, '800')
    assert.equal(byModel.get('cached')!.cacheCollectedRequests, 1)
    assert.equal(byModel.get('uncached')!.cacheReadTokens, null, 'an uncollected breakdown is null, never 0')
    assert.equal(byModel.get('uncached')!.cacheCollectedRequests, 0)
    assert.equal(byModel.get('plain')!.cacheReadTokens, '0', 'a provider-reported zero stays zero')
    assert.equal(byModel.get('plain')!.cacheCollectedRequests, 1)
    // The breakdown is inside the input total, never on top of it.
    for (const row of byModel.values()) {
      assert.ok(Number(row.cacheReadTokens ?? 0) + Number(row.cacheWriteTokens ?? 0) <= Number(row.inputTokens),
        'cache tokens are a breakdown of inputTokens, so they cannot exceed it')
    }
    // Summing across models keeps the same distinction: one model uncollected is not a zero total.
    const total = ((await read('')).hosted as Array<Record<string, unknown>>).reduce((sum, row) => sum + Number(row.cacheReadTokens ?? 0), 0)
    assert.equal(total, 800, 'only collected figures contribute to a total')

    const members = (await read('&groupBy=member')).hosted as Array<Record<string, unknown>>
    // A row stays one dated model point, so a member with two models has two rows:
    // the subdivision splits each point, it does not collapse the model dimension.
    // Group in the assertion rather than expecting one row per member.
    const perMember = new Map<string, number>()
    for (const row of members) perMember.set(row.memberId as string, (perMember.get(row.memberId as string) ?? 0) + Number(row.requests))
    assert.deepEqual([...perMember.entries()].sort(), [['alice', 2], ['bob', 1]], 'a member subdivision splits the same ledger by actorId')
    // The split re-adds to the unsubdivided total: no row is lost or double counted.
    assert.equal(members.reduce((sum, row) => sum + Number(row.costMicroUsd), 0), 175)

    const repos = (await read('&groupBy=repository')).hosted as Array<Record<string, unknown>>
    // Rows stay per dated model point, so the three models produce three rows; what
    // matters is that a call with no completed repository attribution groups under a
    // null repository instead of being dropped by the join.
    assert.ok(repos.length > 0)
    assert.ok(repos.every(row => row.repository === null), 'unattributed calls group under a null repository rather than vanishing')
    assert.equal(repos.reduce((sum, row) => sum + Number(row.requests), 0), 3, 'every call is still counted')

    const csv = await (await report('?from=2026-11-08&to=2026-11-08&groupBy=member&format=csv')).text()
    assert.ok(csv.includes('memberId'), 'a requested subdivision is a CSV column')
    const plainCsv = await (await report('?from=2026-11-08&to=2026-11-08&format=csv')).text()
    assert.ok(!plainCsv.includes('memberId'),
      'an unrequested subdivision stays out of the CSV instead of becoming a column of nulls')
    await pool.query('delete from hosted_usage where "workspaceId"=$1 and "createdAt">=\'2026-11-08\'', [first.id])
  })

  await t.test('usage and template HTTP requests do not invert a real task writer with one connection per pool', async () => {
    const { withTaskWorkspace } = await import('../lib/task-workspace')
    const { writeTransaction } = await import('../lib/operations/write-transaction')
    principal = { id: owner }
    const task = await seedIssue(pool, owner, first.id)
    const saved = await post({ action: 'save', template: { name: 'Pool ordering', rules: { approvalMode: 'read_only' } } })
    assert.equal(saved.status, 200)
    const { id: templateId } = await saved.json()
    try {
      for (const action of ['usage', 'apply'] as const) {
        let entered!: () => void, resume!: () => void
        const ownsWorkspace = new Promise<void>(resolve => { entered = resolve })
        const continueWriter = new Promise<void>(resolve => { resume = resolve })
        const abort = new AbortController()
        const writing = withTaskWorkspace(owner, first.id, async () => {
          entered()
          await continueWriter
          return writeTransaction(pool, async tx => {
            await tx.query('update issues set title=$2 where id=$1', [task, `Committed before ${action}`])
          }, { signal: abort.signal })
        })
        void writing.catch(() => {})
        let pending: Promise<Response> | undefined
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await ownsWorkspace
          pending = action === 'usage' ? report() : post({ action: 'apply', templateId })
          void pending.catch(() => {})
          for (let attempt = 0; attempt < 500 && workspacePool.waitingCount === 0; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 10))
          }
          assert.equal(workspacePool.waitingCount, 1, 'the real governance request must wait for the writer workspace checkout')
          resume()
          const [, response] = await Promise.race([
            Promise.all([writing, pending]),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('APP/WS pool ordering deadlocked')), 5000) }),
          ])
          assert.equal(response.status, 200)
          assert.equal((await pool.query('select title from issues where id=$1', [task])).rows[0].title, `Committed before ${action}`)
        } finally {
          if (timer) clearTimeout(timer)
          abort.abort(); resume()
          await Promise.allSettled([writing, pending])
        }
      }
    } finally {
      await pool.query('delete from issues where id=$1', [task])
      assert.equal((await post({ action: 'delete', templateId })).status, 200)
    }
  })

  await t.test('paid features never grant member, stranger, suspended or token cross-workspace authority', async () => {
    principal = { id: member }
    assert.equal((await get()).status, 200)
    assert.equal((await report()).status, 403)
    principal = { id: stranger }
    assert.equal((await get()).status, 403)
    assert.equal((await report()).status, 403)
    principal = { id: owner, workspaceId: second.id }
    assert.equal((await get()).status, 403)
    assert.equal((await report()).status, 403)
    await pool.query('update mikka_workspace_members set status=\'suspended\' where "workspaceId"=$1 and "userId"=$2', [first.id, member])
    principal = { id: member }
    assert.equal((await report()).status, 403)
    principal = null
    assert.equal((await get()).status, 403)
  })

  await t.test('workspace-owned Team rows are deleted only by the workspace transaction', async () => {
    const { workspaceDeletionStatements } = await import('../lib/workspace-rows')
    const statements = await workspaceDeletionStatements(pool, first.id)
    assert.ok(!statements.some(row => row.table === 'mikka_workspace_entitlements' || row.table === 'mikka_governance_approval_templates'))
    assert.equal((await pool.query('select count(*)::int as n from mikka_workspace_entitlements where "workspaceId"=$1', [first.id])).rows[0].n, 1)
  })
})
