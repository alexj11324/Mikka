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
    assert.deepEqual(data.hosted, [{ day: '2026-11-07', model: '=literal-model', requests: 1, inputTokens: '50', outputTokens: '70', costMicroUsd: '123', freeMicroUsd: '23', purchasedMicroUsd: '100' }])
    assert.deepEqual(data.runs, [{ status: 'succeeded', count: 1 }])
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
