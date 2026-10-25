import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { Pool } from 'pg'
import { CoordinatorInbox, isolatedInboxOptions, wakeFixture } from './wake-test-helpers'

test('actual Coordinator schedule tool uses its persisted workspace and original chat', async () => {
  const url = process.env.WAKE_TEST_DATABASE_URL
  if (
    !url ||
    new URL(url).hostname !== '127.0.0.1' ||
    !new URL(url).pathname.endsWith('_176') ||
    process.env.AI_GATEWAY_API_KEY ||
    process.env.COMPOSIO_API_KEY ||
    process.env.VERCEL
  )
    throw new Error('isolated PG required')
  process.env.MIKKA_DATABASE_URL = url
  process.env.DATABASE_URL = url
  process.env.CI = 'true'
  process.env.MIKKA_RUNTIME_SWEEP_ENABLED = '1'
  process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3176'
  process.env.BETTER_AUTH_SECRET = randomUUID() + randomUUID()
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      return specifier === 'server-only'
        ? { url: 'data:text/javascript,export{}', shortCircuit: true }
        : next(specifier, context)
    },
  })
  const pool = new Pool({ connectionString: url }),
    members = new Pool({ connectionString: url })
  const database = await import('../db/request-scope'),
    scope = database.createRequestDatabaseScope(url)
  try {
    const steps = await import('../../workflows/coordinator/steps'),
      f = await wakeFixture(pool),
      other = randomUUID()
    await pool.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,\'second scope\')', [other, f.owner])
    await pool.query(
      'INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES($1,$2,$2,$3,\'member\')',
      [other, f.owner, `${f.owner}@example.invalid`],
    )
    const inbox = new CoordinatorInbox(
        pool,
        isolatedInboxOptions(pool, members, () => new Date()),
      ),
      holder = randomUUID(),
      receipt = await inbox.take(f.owner, holder)
    assert.ok(receipt.actionContext)
    const definition = {
      title: 'Scoped Coordinator reminder',
      timezone: 'Etc/UTC',
      timing: { kind: 'once' as const, at: new Date(Date.now() + 60000).toISOString() },
      task: { kind: 'reminder' as const, text: 'Only original Coordinator conversation' },
      misfire: 'catch_up_once' as const,
      maxLatenessMinutes: 5,
    }
    const created = await scope.run(() =>
      steps.scheduleCommand(f.owner, { action: 'create', requestId: randomUUID(), definition }, receipt.actionContext),
    )
    assert.ok('schedule' in created, JSON.stringify(created))
    const schedule = created.schedule
    assert.equal(schedule.workspace_id, f.workspace)
    assert.equal(schedule.source_id, f.eventId)
    assert.equal(schedule.session_id, f.owner)
    const listed = await scope.run(() => steps.scheduleCommand(f.owner, { action: 'list' }, receipt.actionContext))
    assert.ok('schedules' in listed && listed.schedules)
    assert.equal(listed.schedules.length, 1)
    const paused = await scope.run(() =>
      steps.scheduleCommand(f.owner, { action: 'pause', scheduleId: schedule.id, version: 1 }, receipt.actionContext),
    )
    assert.ok('schedule' in paused)
    assert.equal(paused.schedule.status, 'paused')
    await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1', [f.workspace])
    await assert.rejects(
      scope.run(() =>
        steps.scheduleCommand(
          f.owner,
          { action: 'resume', scheduleId: schedule.id, version: 2 },
          receipt.actionContext,
        ),
      ),
      /wakeWorkspaceAccessDenied/,
    )
    assert.equal(
      (await pool.query('SELECT status FROM user_schedules WHERE id=$1', [schedule.id])).rows[0].status,
      'paused',
    )
    console.log(
      JSON.stringify({
        evidence: 'actual tool handler, not model conversation',
        owner: f.owner,
        sourceEventId: f.eventId,
        workspaceId: f.workspace,
        scheduleId: schedule.id,
        otherWorkspaceId: other,
      }),
    )
  } finally {
    hooks.deregister()
    await scope.close()
    await database.pool.end()
    await (globalThis as unknown as { workspacePool?: Pool }).workspacePool?.end()
    await pool.end()
    await members.end()
  }
})
