// ALE-77: who a thread says dispatched it, for the five shapes a run can carry.
//
// `agent_runs.botId` is ON DELETE SET NULL (drizzle/20261027010000_bots.sql), so it forgets the
// dispatch when a Bot goes away. The identity frozen at dispatch keeps recording it
// (lib/execution-identity.ts:96), which is what tells these shapes apart:
//
//   a live Bot dispatched it              -> that Bot
//   an MCP client's run (no Bot)          -> Coordinator, which ran it locally
//   a Bot dispatched it, then was deleted -> Coordinator, which ran it
//   a Bot that outlived its owner         -> that Bot, still (「待接管」)
//   no recorded identity (historical)     -> whatever the Agent itself is called
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedAgent, seedBot, seedRun, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('a thread names the Bot that dispatched it, even after that Bot loses its owner', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { db } = await import('../lib/db')
  const { agentRuns, agents } = await import('../lib/db/schema')
  const { runBotName } = await import('../lib/run-bot-name')
  const { eq } = await import('drizzle-orm')
  t.after(async () => { await Promise.all([pool.end(), appPool.end(), workspacePool.end()]) })

  const owner = await seedUser(pool, 'owner')
  const ws = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  // Named the way lib/device-agents.ts:41 names a device Agent (`<harness> <deviceId>`), which is the
  // shape the removed `^(claude_code|codex|mock) <uuid>$` tier used to answer "Coordinator" for.
  const device = randomUUID()
  await pool.query('insert into devices (id,"ownerId",name,kind,enabled) values ($1,$2,\'local\',\'local\',true)', [device, owner])
  const agent = await seedAgent(pool, owner, 'codex')
  await pool.query('update agents set name=$2, "deviceId"=$3 where id=$1', [agent, `codex ${device}`, device])

  // What freezeExecutionIdentity writes: the dispatching Bot as the run's own contract records it.
  const identity = (botId: string | null) => ({
    executionIdentity: {
      version: 1, requester: owner, botId, botOwner: botId ? owner : null, executionPrincipal: owner,
      workspaceId: ws.id, outputOwner: owner, resourceBindings: [], personalResourcePolicy: 'requester_only',
      billingAccount: {
        model: { kind: 'native_login', ownerId: owner, resourceId: agent, amount: 'provider_unknown' },
        runtime: { kind: 'local_device', ownerId: owner, resourceId: agent, amount: 'not_applicable' },
      },
    },
  })
  const run = async (label: string, botId: string | null, definition: object) => {
    const id = await seedRun(pool, { userId: owner, agentId: agent, botId, workspaceId: ws.id })
    await pool.query('update agent_runs set "agentDefinition"=$2 where id=$1', [id, JSON.stringify(definition)])
    return { id, label }
  }
  const nameOf = async (runId: string) => {
    const [row] = await db.select({ name: runBotName }).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId)).where(eq(agentRuns.id, runId))
    return row?.name
  }

  const liveBot = await seedBot(pool, ws.id, owner, 'Bot A')
  const doomedBot = await seedBot(pool, ws.id, owner, 'Bot that is deleted')
  const departedBot = await seedBot(pool, ws.id, owner, "Departed person's Bot")

  const live = await run('a live Bot dispatched it', liveBot, identity(liveBot))
  const mcp = await run('an MCP client dispatched it', null, identity(null))
  const deleted = await run('its Bot was deleted afterwards', doomedBot, identity(doomedBot))
  const takeover = await run('its Bot outlived its owner', departedBot, identity(departedBot))
  const unrecorded = await run('no identity was ever recorded', null, {})

  // The two ways a Bot stops naming a run, applied the way the product applies them:
  // a departing owner leaves the Bot behind with no owner (lib/account/delete.ts:421)…
  await pool.query('update bots set "ownerId"=null, "archivedAt"=now() where id=$1', [departedBot])
  // …and a deleted Bot takes its run's live reference with it (ON DELETE SET NULL).
  await pool.query('delete from bots where id=$1', [doomedBot])

  await t.test('each shape resolves to the Bot, or the Coordinator, that actually ran it', async () => {
    assert.equal(await nameOf(live.id), 'Bot A', 'a live dispatching Bot names the thread')
    assert.equal(await nameOf(mcp.id), 'Coordinator', 'no Bot dispatched it, so the Coordinator that ran it is named')
    assert.equal(await nameOf(deleted.id), 'Coordinator', 'a deleted Bot cannot name a thread; the Coordinator that ran it does')
    // The ALE-77 case: the Bot row is still there, and so is the record that it dispatched the run.
    assert.equal(await nameOf(takeover.id), "Departed person's Bot", "a Bot awaiting takeover still names the thread it dispatched")
  })

  await t.test('a historical run with no recorded identity keeps reading Coordinator', async () => {
    // Historical rows predate the frozen identity, so they cannot be told apart from a genuine
    // local MCP run. Coordinator here is a gap in the record, not a claim about who dispatched
    // them. If identity is ever backfilled, this expectation should change with it: the assertion
    // is pinned so that closing the gap stays deliberate, not so that the gap stays forever.
    assert.equal(await nameOf(unrecorded.id), 'Coordinator')
  })

  await t.test('the three shapes that share one Agent name stay distinguishable', async () => {
    // All three runs use the same Agent, so only the attribution columns tell them apart.
    const classes = (await pool.query<{ class: string }>(`
      select case
        when r."agentDefinition"->'executionIdentity' is null then 'unrecorded'
        when r."agentDefinition"->'executionIdentity'->>'botId' is null then 'no_bot_dispatched'
        when exists (select 1 from bots b where b.id::text = r."agentDefinition"->'executionIdentity'->>'botId' and b."ownerId" is null) then 'bot_awaiting_takeover'
        when exists (select 1 from bots b where b.id::text = r."agentDefinition"->'executionIdentity'->>'botId') then 'bot_live'
        else 'bot_deleted' end as class
      from agent_runs r where r.id = any($1::uuid[])`, [[mcp.id, deleted.id, takeover.id]])).rows.map(row => row.class)
    assert.deepEqual([...new Set(classes)].sort(), ['bot_awaiting_takeover', 'bot_deleted', 'no_bot_dispatched'],
      'the MCP run, the deleted Bot and the awaiting-takeover Bot are three different things')
  })
})
