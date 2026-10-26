import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readFile, readdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { Pool } from 'pg'
import { CoordinatorInbox, wakeFixture } from './wake-test-helpers'
import { SessionMailbox } from '../session-mailbox'
import type { AsyncLocalStorage } from 'node:async_hooks'

test('review: background terminal fairness, protocol scope, cached guard and quiet triage', async (t) => {
  const url = process.env.WAKE_REVIEW_TEST_DATABASE_URL
  if (
    !url ||
    new URL(url).hostname !== '127.0.0.1' ||
    !new URL(url).pathname.endsWith('_176') ||
    [
      'VERCEL',
      'AI_GATEWAY_API_KEY',
      'DECISION_GATEWAY_API_KEY',
      'OPENAI_API_KEY',
      'OPENCODE_API_KEY',
      'COMPOSIO_API_KEY',
    ].some((k) => process.env[k])
  )
    throw new Error('isolated keyless review PG only')
  Object.assign(process.env, {
    MIKKA_DATABASE_URL: url,
    DATABASE_URL: url,
    CI: 'true',
    BETTER_AUTH_URL: 'http://127.0.0.1:3176',
    BETTER_AUTH_SECRET: randomUUID() + randomUUID(),
    MIKKA_WAKE_CONTROLLED_ORIGIN: 'http://127.0.0.1:6176',
    MIKKA_WAKE_CONTROLLED_TOKEN: 'synthetic-review-transport',
  })
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      return specifier === 'server-only'
        ? { url: 'data:text/javascript,export{}', shortCircuit: true }
        : next(specifier, context)
    },
  })
  const pool = new Pool({ connectionString: url, max: 15 }),
    database = await import('../db/request-scope'),
    scope = database.createRequestDatabaseScope(url),
    runtime = await import('./inbox-runtime'),
    steps = await import('../../workflows/coordinator/steps'),
    wake = await import('./wake')
  let now = new Date()
  const inbox = () =>
    new CoordinatorInbox(pool, { ...runtime.coordinatorInboxOptions(), clock: () => now, leaseMs: 1000 })
  const run = <T>(fn: () => T) => scope.run(fn)
  const row = async (id: string) => (await pool.query('SELECT * FROM coordinator_events WHERE id=$1', [id])).rows[0]
  const claimed = async (owner: string) => {
    now = new Date(Math.max(now.getTime(), Date.now() + 10))
    const c = await run(() => inbox().claim(owner))
    assert.ok(c && 'delivery' in c)
    return c.delivery
  }
  async function background(owner: string, workspace: string, issueId: string | null = null, status = 'pending') {
    const id = randomUUID()
    await pool.query(
      `INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload,tier,wake_workspace_id,"issueId",wake_status) VALUES($1::uuid,$2,'run_report',$1::text,'{}','background',$3,$4,$5)`,
      [id, owner, workspace, issueId, status],
    )
    return id
  }
  const counts = new Map<string, number>()
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const d of req) body += d
    const input = JSON.parse(body)
    counts.set(input.owner, (counts.get(input.owner) ?? 0) + 1)
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ runId: 'controlled-review-transport' }))
  })
  server.listen(6176, '127.0.0.1')
  await once(server, 'listening')
  try {
    await t.test(
      'follow-up migration upgrades the previous receipt schema without changing terminal scopes or granting membership',
      async () => {
        const namespace = `wake_upgrade_${randomUUID().replaceAll('-', '')}`
        await pool.query(`CREATE SCHEMA ${namespace}`)
        const fixture = new Pool({ connectionString: url, options: `-c search_path=${namespace}` })
        try {
          const initial = '20261026002531_coordinator_consumption_receipts.sql',
            followup = '20261026002532_coordinator_effect_fences.sql'
          const names = orderMigrations(
            (await readdir(new URL('../../drizzle/', import.meta.url))).filter((n) => n.endsWith('.sql')),
          )
          for (const name of names.filter((n) => n !== initial && n !== followup))
            await fixture.query(await readFile(new URL(`../../drizzle/${name}`, import.meta.url), 'utf8'))
          // Exact previously reviewed migration, not a reconstructed auth mock.
          await fixture.query(
            execFileSync('git', ['show', `6c725df72f4fd4e70d85271bc0666529615a0496:drizzle/20261025191001_coordinator_consumption_receipts.sql`], {
              encoding: 'utf8',
            }),
          )
          const owner = `upgrade-${randomUUID()}`,
            device = randomUUID(),
            agent = randomUUID(),
            runId = randomUUID(),
            box = randomUUID(),
            old = randomUUID(),
            protocol = '00000000-0000-4000-8000-000000000001'
          await fixture.query(
            'INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',
            [owner, `${owner}@example.invalid`],
          )
          await fixture.query('INSERT INTO devices(id,"ownerId",name) VALUES($1,$2,\'upgrade fixture\')', [
            device,
            owner,
          ])
          await fixture.query(
            'INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,\'upgrade fixture\',\'codex\',$3)',
            [agent, owner, device],
          )
          await fixture.query(
            'INSERT INTO session_mailboxes(id,"userId","workspaceId",kind,"sessionKey") VALUES($1,$2,$3,\'run\',$4)',
            [box, owner, protocol, runId],
          )
          await fixture.query(
            'INSERT INTO agent_runs(id,"userId","agentId","deviceId","mailboxId",status) VALUES($1,$2,$3,$4,$5,\'succeeded\')',
            [runId, owner, agent, device, box],
          )
          await fixture.query(
            `INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload,tier,"runId") VALUES($1::uuid,$2,'run_report',$1::text,'{}','result',$3)`,
            [old, owner, runId],
          )
          await fixture.query(
            "UPDATE coordinator_events SET wake_status='cancelled',wake_error='wakeWorkspaceAccessDenied' WHERE id=$1",
            [old],
          )
          const snapshot = async () =>
            (
              await fixture.query(
                'SELECT id,wake_workspace_id,wake_status,wake_error,processed_at FROM coordinator_events WHERE id=$1',
                [old],
              )
            ).rows[0]
          const before = await snapshot()
          assert.equal(before.wake_workspace_id, protocol)
          const migration = await readFile(new URL(`../../drizzle/${followup}`, import.meta.url), 'utf8')
          await fixture.query(migration)
          await fixture.query(migration)
          assert.deepEqual(await snapshot(), before)
          const fresh = randomUUID()
          await fixture.query(
            `INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload,tier,"runId") VALUES($1::uuid,$2,'run_report',$1::text,'{}','result',$3)`,
            [fresh, owner, runId],
          )
          const current = (
            await fixture.query('SELECT wake_workspace_id,wake_tool_receipts FROM coordinator_events WHERE id=$1', [
              fresh,
            ])
          ).rows[0]
          assert.equal(current.wake_workspace_id, null)
          assert.deepEqual(current.wake_tool_receipts, {})
          assert.equal(
            (await fixture.query('SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1', [protocol])).rowCount,
            0,
          )
        } finally {
          await fixture.end()
        }
      },
    )
    await t.test(
      '49 denied background rows cannot starve a later legal child across actual child SIGKILL',
      async () => {
        const f = await wakeFixture(pool),
          foreign = `foreign-${randomUUID()}`,
          issue = randomUUID()
        await pool.query(
          "INSERT INTO issues(id,\"userId\",title,content,status,priority) VALUES($1,$2,'private','{}','todo','normal')",
          [issue, foreign],
        )
        const prefix = []
        for (let n = 0; n < 49; n++) prefix.push(await background(f.owner, f.workspace, issue))
        const legal = await background(f.owner, f.workspace),
          d = await claimed(f.owner),
          h = randomUUID()
        assert.equal((await run(() => inbox().take(f.owner, h, d))).added, 1)
        assert.ok(
          (await Promise.all(prefix.map(row))).every(
            (e) => e.wake_status === 'cancelled' && !e.deliveredAt && !e.processed_at,
          ),
        )
        await run(() => inbox().acknowledge(f.owner, h, d, []))
        // Restore actual issue ownership: terminal decisions must still not revive.
        await pool.query('UPDATE issues SET "userId"=$2 WHERE id=$1', [issue, f.owner])
        const next = randomUUID()
        await pool.query(
          `INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload,tier,wake_workspace_id) VALUES($1::uuid,$2,'user_message',$1::text,'{"text":"next"}','attention',$3)`,
          [next, f.owner, f.workspace],
        )
        const delivery = await claimed(f.owner),
          holder = randomUUID()
        const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/fixtures/wake-authority-consumer.ts'], {
          env: {
            ...process.env,
            WAKE_CHILD_INPUT: JSON.stringify({ owner: f.owner, holder, delivery, clock: now.toISOString() }),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        const reader = createInterface({ input: child.stdout })
        const timer = setTimeout(() => child.kill('SIGKILL'), 15000)
        let staged
        try {
          const [line] = await Promise.race([
            once(reader, 'line'),
            once(child, 'exit').then(() => {
              throw new Error('authority child exited before staging')
            }),
          ])
          staged = JSON.parse(line)
          const exited = once(child, 'exit')
          child.kill('SIGKILL')
          assert.deepEqual(await exited, [null, 'SIGKILL'])
        } finally {
          clearTimeout(timer)
          reader.close()
        }
        assert.equal(staged.added, 2)
        now = new Date(now.getTime() + 1500)
        const replacement = await claimed(f.owner),
          newHolder = randomUUID()
        assert.equal((await run(() => inbox().take(f.owner, newHolder, replacement))).added, 2)
        await run(() =>
          inbox().acknowledge(f.owner, newHolder, replacement, [
            { role: 'assistant', content: 'controlled background fairness result' },
          ]),
        )
        assert.equal((await row(legal)).wake_status, 'completed')
        assert.ok(
          (await Promise.all(prefix.map(row))).every(
            (e) => e.wake_status === 'cancelled' && !e.deliveredAt && !e.processed_at,
          ),
        )
        console.log(
          JSON.stringify({
            evidence: 'actual PG + actual authority child SIGKILL',
            prefix: 49,
            parent: next,
            legal,
            terminalRowsNotRevived: true,
          }),
        )
      },
    )
    await t.test('failed, cancelled and legacy_review background rows remain terminal', async () => {
      const f = await wakeFixture(pool),
        ids = []
      for (const state of ['failed', 'cancelled', 'legacy_review'])
        ids.push(await background(f.owner, f.workspace, null, state))
      const other = randomUUID()
      await pool.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,\'other\')', [other, 'other-owner'])
      const cross = await background(f.owner, other),
        d = await claimed(f.owner),
        h = randomUUID()
      assert.equal((await run(() => inbox().take(f.owner, h, d))).added, 1)
      await run(() => inbox().acknowledge(f.owner, h, d, []))
      assert.deepEqual(
        (await Promise.all(ids.map(row))).map((e) => e.wake_status),
        ['failed', 'cancelled', 'legacy_review'],
      )
      assert.equal((await row(cross)).deliveredAt, null)
    })
    await t.test('protocol mailbox partition is not a real tenant grant', async () => {
      const f = await wakeFixture(pool)
      await pool.query("UPDATE coordinator_events SET processed_at=now(),wake_status='completed' WHERE id=$1", [
        f.eventId,
      ])
      const protocol = '00000000-0000-4000-8000-000000000001',
        device = randomUUID(),
        agent = randomUUID(),
        runId = randomUUID()
      await pool.query('INSERT INTO devices(id,"ownerId",name) VALUES($1,$2,\'scope fixture\')', [device, f.owner])
      await pool.query(
        'INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,\'scope fixture\',\'codex\',$3)',
        [agent, f.owner, device],
      )
      await pool.query(
        'INSERT INTO agent_runs(id,"userId","agentId","deviceId",status) VALUES($1,$2,$3,$4,\'running\')',
        [runId, f.owner, agent, device],
      )
      const boxes = new SessionMailbox(pool, protocol)
      await boxes.run(f.owner, runId)
      await boxes.complete(f.owner, runId, 'succeeded', 'submitted', { summary: 'real protocol completion' })
      const event = (
        await pool.query(`SELECT * FROM coordinator_events WHERE "runId"=$1 AND kind='run_report'`, [runId])
      ).rows[0]
      assert.equal(
        (
          await pool.query('SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [
            protocol,
            f.owner,
          ])
        ).rowCount,
        0,
      )
      assert.equal(event.wake_workspace_id, null)
      const d = await claimed(f.owner),
        h = randomUUID()
      assert.equal((await run(() => inbox().take(f.owner, h, d))).held, true)
      await run(() =>
        inbox().acknowledge(f.owner, h, d, [
          { role: 'assistant', content: 'completed without fabricated sentinel membership' },
        ]),
      )
    })
    await t.test(
      'real tenant capture, mismatch, withdrawal and personal issue/device authority remain enforced',
      async () => {
        const protocol = '00000000-0000-4000-8000-000000000001'
        async function completed(
          partition: 'real' | 'protocol',
          issueForeign = false,
          deviceForeign = false,
          explicit?: 'wrong' | 'protocol' | 'real',
        ) {
          const f = await wakeFixture(pool),
            d = await claimed(f.owner),
            h = randomUUID()
          await run(() => inbox().take(f.owner, h, d))
          await run(() => inbox().acknowledge(f.owner, h, d, []))
          const device = randomUUID(),
            agent = randomUUID(),
            runId = randomUUID(),
            box = randomUUID(),
            issue = issueForeign ? randomUUID() : null
          if (issue)
            await pool.query(
              "INSERT INTO issues(id,\"userId\",title,content,status,priority) VALUES($1,'foreign','private issue','{}','todo','normal')",
              [issue],
            )
          await pool.query('INSERT INTO devices(id,"ownerId",name) VALUES($1,$2,\'authority fixture\')', [
            device,
            deviceForeign ? 'foreign' : f.owner,
          ])
          await pool.query(
            'INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,\'authority fixture\',\'codex\',$3)',
            [agent, f.owner, device],
          )
          await pool.query(
            'INSERT INTO session_mailboxes(id,"userId","workspaceId",kind,"sessionKey") VALUES($1,$2,$3,\'run\',$4)',
            [box, f.owner, partition === 'protocol' ? protocol : f.workspace, runId],
          )
          await pool.query(
            'INSERT INTO agent_runs(id,"userId","agentId","deviceId","mailboxId","issueId",status) VALUES($1,$2,$3,$4,$5,$6,\'succeeded\')',
            [runId, f.owner, agent, device, box, issue],
          )
          let explicitScope: string | null = null
          if (explicit === 'protocol') explicitScope = protocol
          if (explicit === 'real') explicitScope = f.workspace
          if (explicit === 'wrong') {
            explicitScope = randomUUID()
            await pool.query(
              'INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,\'other authorized scope\')',
              [explicitScope, f.owner],
            )
            await pool.query(
              'INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES($1,$2,$2,$3,\'member\')',
              [explicitScope, f.owner, `${f.owner}@example.invalid`],
            )
          }
          const event = randomUUID()
          await pool.query(
            `INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload,tier,"runId","issueId",wake_workspace_id) VALUES($1::uuid,$2,'run_report',$1::text,'{}','result',$3,$4,$5)`,
            [event, f.owner, runId, issue, explicitScope],
          )
          return { ...f, event, runId }
        }
        const explicitReal = await completed('protocol', false, false, 'real'),
          explicitDelivery = await claimed(explicitReal.owner),
          explicitHolder = randomUUID()
        await run(() => inbox().take(explicitReal.owner, explicitHolder, explicitDelivery))
        await run(() => inbox().acknowledge(explicitReal.owner, explicitHolder, explicitDelivery, []))
        assert.equal((await row(explicitReal.event)).wake_workspace_id, explicitReal.workspace)
        const real = await completed('real')
        assert.equal((await row(real.event)).wake_workspace_id, real.workspace)
        const realDelivery = await claimed(real.owner),
          realHolder = randomUUID()
        await run(() => inbox().take(real.owner, realHolder, realDelivery))
        await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1', [
          real.workspace,
        ])
        await assert.rejects(
          run(() =>
            inbox().acknowledge(real.owner, realHolder, realDelivery, [
              { role: 'assistant', content: 'must not publish after withdrawal' },
            ]),
          ),
          /wakeWorkspaceAccessDenied/,
        )
        for (const [f, error] of [
          [await completed('real', false, false, 'wrong'), 'wakeWorkspaceMismatch'],
          [await completed('protocol', true), 'wakeIssueAccessDenied'],
          [await completed('protocol', false, true), 'wakeRunAccessDenied'],
          [await completed('protocol', false, false, 'protocol'), 'wakeWorkspaceAccessDenied'],
        ] as const) {
          now = new Date(Math.max(now.getTime(), Date.now() + 10))
          const claim = await run(() => inbox().claim(f.owner))
          assert.ok(claim && 'exhausted' in claim)
          const event = await row(f.event)
          assert.equal(event.wake_status, 'cancelled')
          assert.equal(event.wake_error, error)
          assert.equal(event.deliveredAt, null)
          assert.equal(
            (
              await pool.query('SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [
                protocol,
                f.owner,
              ])
            ).rowCount,
            0,
          )
        }
      },
    )
    for (const name of ['remember', 'forget', 'mailboxAction'] as const)
      await t.test(`cached successful guard cannot authorize a later stale ${name} effect`, async () => {
        const f = await wakeFixture(pool),
          d = await claimed(f.owner),
          holder = randomUUID()
        await run(() => inbox().take(f.owner, holder, d))
        await run(() => inbox().assertCurrent(f.owner, holder, d))
        await pool.query('UPDATE coordinator_sessions SET memory=\'preserve this note\' WHERE "userId"=$1', [f.owner])
        const bot = randomUUID()
        await pool.query('INSERT INTO agent_sessions(id,"userId",title) VALUES($1,$2,\'stale target\')', [bot, f.owner])
        const target = await new SessionMailbox(pool, '00000000-0000-4000-8000-000000000001').conversation(
          f.owner,
          'bot',
          bot,
        )
        now = new Date(now.getTime() + 1500)
        const current = await claimed(f.owner)
        await run(() => inbox().take(f.owner, randomUUID(), current))
        const args: unknown[] =
          name === 'remember'
            ? [{ note: 'STALE MUST NOT APPEND' }]
            : name === 'forget'
              ? [{ text: 'preserve' }]
              : ['send', { to: target.mailboxId, key: randomUUID(), text: 'STALE MUST NOT SEND' }]
        // Precise controlled substitute for SDK cache replay: the successful guard
        // above is intentionally not re-run. Invoke the actual effect handler after
        // PG holder/token takeover. No model or fake DB authority is involved.
        const dispatcher = (steps as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)
          .executeWakeTool
        const effect = () =>
          run(() =>
            dispatcher
              ? dispatcher(f.owner, holder, d, name, args)
              : (steps[name] as (...args: unknown[]) => Promise<unknown>)(f.owner, ...args),
          )
        let denied = false
        try {
          await effect()
        } catch (e) {
          denied = /wakeLeaseLost/.test(String(e))
        }
        const memory = (await pool.query('SELECT memory FROM coordinator_sessions WHERE "userId"=$1', [f.owner]))
          .rows[0].memory
        const writes = (
          await pool.query('SELECT count(*)::int n FROM run_messages WHERE "mailboxId"=$1', [target.mailboxId])
        ).rows[0].n
        console.log(
          JSON.stringify({
            evidence: 'controlled cached-guard substitute; real effect handler and PG',
            name,
            denied,
            memoryUnchanged: memory === 'preserve this note',
            messageWrites: writes,
          }),
        )
        assert.equal(denied, true)
        assert.equal(memory, 'preserve this note')
        assert.equal(writes, 0)
      })
    await t.test(
      'fresh internal effects and SDK-step receipts commit together and replay without duplicate memory/message writes',
      async () => {
        const f = await wakeFixture(pool),
          d = await claimed(f.owner),
          holder = randomUUID()
        await run(() => inbox().take(f.owner, holder, d))
        const storage = (globalThis as unknown as Record<symbol, AsyncLocalStorage<unknown>>)[
          Symbol.for('WORKFLOW_STEP_CONTEXT_STORAGE')
        ]
        assert.ok(storage)
        const dispatch = (name: string, args: unknown[], stepId: string) =>
          run(() =>
            storage.run(
              { stepMetadata: { stepId, attempt: 1, stepName: 'executeWakeTool', stepStartedAt: new Date() } },
              () => steps.executeWakeTool(f.owner, holder, d, name, args),
            ),
          )
        const first = `step_review_${randomUUID().replaceAll('-', '')}`
        const results = await Promise.all(
          Array.from({ length: 10 }, () => dispatch('remember', [{ note: 'exactly one internal note' }], first)),
        )
        assert.ok(results.every((r) => (r as { remembered: boolean }).remembered))
        assert.equal(
          (await pool.query('SELECT memory FROM coordinator_sessions WHERE "userId"=$1', [f.owner])).rows[0].memory,
          '- exactly one internal note',
        )
        await assert.rejects(dispatch('remember', [{ note: 'changed binding' }], first), /wakeEffectBindingConflict/)
        const forget = `step_review_${randomUUID().replaceAll('-', '')}`
        assert.deepEqual(await dispatch('forget', [{ text: 'internal note' }], forget), { removed: 1 })
        assert.deepEqual(await dispatch('forget', [{ text: 'internal note' }], forget), { removed: 1 })
        const bot = randomUUID()
        await pool.query('INSERT INTO agent_sessions(id,"userId",title) VALUES($1,$2,\'atomic target\')', [
          bot,
          f.owner,
        ])
        const target = await new SessionMailbox(pool, '00000000-0000-4000-8000-000000000001').conversation(
          f.owner,
          'bot',
          bot,
        )
        const send = `step_review_${randomUUID().replaceAll('-', '')}`,
          input = { to: target.mailboxId, key: randomUUID(), text: 'exactly one internal message' }
        const sent = await Promise.all(
          Array.from({ length: 10 }, () => dispatch('mailboxAction', ['send', input], send)),
        )
        assert.equal(new Set(sent.map((r) => (r as { id: string }).id)).size, 1)
        assert.equal(
          (await pool.query('SELECT count(*)::int n FROM run_messages WHERE "mailboxId"=$1', [target.mailboxId]))
            .rows[0].n,
          1,
        )
        const faultStep = `step_review_${randomUUID().replaceAll('-', '')}`,
          fault = `effect_fault_${randomUUID().replaceAll('-', '')}`
        await pool.query(
          `CREATE FUNCTION ${fault}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.eventId}'::uuid AND NEW.wake_tool_receipts ? '${faultStep}' THEN RAISE EXCEPTION 'controlled receipt commit fault'; END IF; RETURN NEW; END $$`,
        )
        await pool.query(
          `CREATE TRIGGER ${fault} BEFORE UPDATE OF wake_tool_receipts ON coordinator_events FOR EACH ROW EXECUTE FUNCTION ${fault}()`,
        )
        try {
          await assert.rejects(
            dispatch('remember', [{ note: 'atomic rollback note' }], faultStep),
            /receipt commit fault/,
          )
        } finally {
          await pool.query(`ALTER TABLE coordinator_events DISABLE TRIGGER ${fault}`)
        }
        assert.equal(
          (await pool.query('SELECT memory FROM coordinator_sessions WHERE "userId"=$1', [f.owner])).rows[0].memory,
          '',
        )
        assert.equal((await row(f.eventId)).wake_tool_receipts[faultStep], undefined)
        await dispatch('remember', [{ note: 'atomic rollback note' }], faultStep)
        assert.equal(
          (await pool.query('SELECT memory FROM coordinator_sessions WHERE "userId"=$1', [f.owner])).rows[0].memory,
          '- atomic rollback note',
        )
        await assert.rejects(
          pool.query("UPDATE coordinator_events SET wake_tool_receipts='{}' WHERE id=$1", [f.eventId]),
          /effect receipt is immutable/,
        )
        console.log(
          JSON.stringify({
            evidence: 'synthetic SDK metadata; actual getStepMetadata/effect handlers/PG transactions',
            eventId: f.eventId,
            tenReplays: 1,
            mailboxWrites: 1,
            receiptFaultRolledMemoryBack: true,
          }),
        )
      },
    )
    for (const kind of ['run_report', 'run_retried'] as const)
      await t.test(`quiet ${kind} triages before any transport start`, async () => {
        const f = await wakeFixture(pool)
        await pool.query('UPDATE coordinator_events SET kind=$2,tier=NULL,payload=$3 WHERE id=$1', [
          f.eventId,
          kind,
          kind === 'run_report' ? { text: 'quiet controlled progress' } : {},
        ])
        await run(() => wake.wakeCoordinator(f.owner))
        assert.equal((await row(f.eventId)).tier, 'background')
        assert.equal(counts.get(f.owner) ?? 0, 0)
      })
    await t.test('late delivery whose tier became background never stages or starts generation', async () => {
      const f = await wakeFixture(pool),
        d = await claimed(f.owner)
      await pool.query("UPDATE coordinator_events SET tier='background' WHERE id=$1", [f.eventId])
      const h = randomUUID(),
        receipt = await run(() => inbox().take(f.owner, h, d))
      let generated = false
      if (receipt.held) generated = (await run(() => inbox().beginGeneration(f.owner, h, d))).generate
      console.log(
        JSON.stringify({
          evidence: 'actual core delivery/positive controlled admission; no model called',
          held: receipt.held,
          generationWouldStart: generated,
        }),
      )
      assert.equal(receipt.held, false)
      assert.equal(generated, false)
      assert.equal((await row(f.eventId)).deliveredAt, null)
    })
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
    hooks.deregister()
    await scope.close()
    await database.pool.end()
    await (globalThis as unknown as { workspacePool?: Pool }).workspacePool?.end()
    await pool.end()
  }
})
