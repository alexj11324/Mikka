// Keyless, local-only SDK replay harness. Dynamic source is a fixed trusted
// orchestration of already registered production steps, not a model/provider.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { Pool } from 'pg'
import { start } from 'workflow/api'
import { getWorld } from 'workflow/runtime'
import { CoordinatorInbox, isolatedInboxOptions, wakeFixture } from '../lib/coordinator/wake-test-helpers.ts'
import { SessionMailbox } from '../lib/session-mailbox.ts'
const url = process.env.WAKE_TEST_DATABASE_URL,
  origin = process.env.WORKFLOW_LOCAL_BASE_URL,
  before = process.env.WAKE_SDK_REVIEW_BEFORE === '1'
if (
  !url ||
  new URL(url).hostname !== '127.0.0.1' ||
  !new URL(url).pathname.endsWith('_176') ||
  process.env.WORKFLOW_TARGET_WORLD !== 'local' ||
  origin !== 'http://127.0.0.1:3177/mikka' ||
  process.env.WORKFLOW_EXPERIMENTAL_DYNAMIC_WORKFLOWS !== '1' ||
  !['/workspace/176-private-evidence/', '/tmp/mikka-sdk-176-'].some((p) =>
    process.env.WORKFLOW_LOCAL_DATA_DIR?.startsWith(p),
  ) ||
  [
    'VERCEL',
    'AI_GATEWAY_API_KEY',
    'DECISION_GATEWAY_API_KEY',
    'OPENCODE_API_KEY',
    'OPENAI_API_KEY',
    'COMPOSIO_API_KEY',
  ].some((k) => process.env[k])
)
  throw new Error('isolated keyless dynamic replay harness only')
const manifest = JSON.parse(readFileSync('.next/diagnostics/workflows-manifest.json', 'utf8')),
  registered = manifest.steps['workflows/coordinator/steps.ts']
if (!before) assert.ok(registered.executeWakeTool)
const world = await getWorld(),
  pool = new Pool({ connectionString: url }),
  members = new Pool({ connectionString: url }),
  runs = []
const inbox = new CoordinatorInbox(pool, { ...isolatedInboxOptions(pool, members, () => new Date()), leaseMs: 10000 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = (x) => console.log(JSON.stringify({ at: new Date().toISOString(), ...x }))
async function wait(fn, label) {
  const end = Date.now() + 30000
  while (Date.now() < end) {
    if (await fn()) return
    await sleep(50)
  }
  throw new Error(`timeout: ${label}`)
}
async function ready() {
  await wait(async () => {
    try {
      return (await fetch(`${origin}/api/auth/get-session`)).status === 200
    } catch {
      return false
    }
  }, 'isolated Next ready')
}
async function fixture() {
  const f = await wakeFixture(pool),
    c = await inbox.claim(f.owner)
  assert.ok(c && 'delivery' in c)
  const holder = `sdk-fixture-${randomUUID()}`
  await inbox.take(f.owner, holder, c.delivery)
  await pool.query('UPDATE coordinator_sessions SET memory=\'preserve original note\' WHERE "userId"=$1', [f.owner])
  const bot = randomUUID()
  await pool.query('INSERT INTO agent_sessions(id,"userId",title) VALUES($1,$2,\'SDK fenced target\')', [bot, f.owner])
  const target = await new SessionMailbox(pool, '00000000-0000-4000-8000-000000000001').conversation(
    f.owner,
    'bot',
    bot,
  )
  return { ...f, holder, delivery: c.delivery, target }
}
async function stepList(run) {
  return (await world.steps.list({ runId: run.runId, resolveData: 'none' })).data
}
try {
  await ready()
  log({
    phase: 'actual SDK effect replay harness ready',
    beforeFix: before,
    cloudWorkflow: false,
    realModel: false,
    sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    nextBuildId: readFileSync('.next/BUILD_ID', 'utf8').trim(),
  })
  let reproduced = 0
  for (const name of ['remember', 'forget', 'mailboxAction']) {
    const f = await fixture(),
      args =
        name === 'remember'
          ? [{ note: 'stale must not append' }]
          : name === 'forget'
            ? [{ text: 'preserve' }]
            : ['send', { to: f.target.mailboxId, key: randomUUID(), text: 'stale must not send' }]
    const effect = before ? registered[name] : registered.executeWakeTool
    const source = `async function workflow(input){"use workflow";await steps.guard(input.owner,input.holder,input.delivery);await sleep("3s");return ${before ? 'steps.effect(input.owner,...input.args)' : 'steps.effect(input.owner,input.holder,input.delivery,input.name,input.args)'};}`
    const run = await start(source, [{ owner: f.owner, holder: f.holder, delivery: f.delivery, name, args }], {
      experimental_dynamic: { steps: { guard: registered.assertWakeCurrent, effect } },
    })
    runs.push(run)
    await wait(
      async () =>
        (await stepList(run)).some(
          (s) => s.stepName === registered.assertWakeCurrent.stepId && s.status === 'completed',
        ),
      'successful real guard persisted',
    )
    await pool.query(
      'UPDATE coordinator_sessions SET "leaseUntil"=clock_timestamp()-interval \'1 second\' WHERE "userId"=$1',
      [f.owner],
    )
    await pool.query(
      "UPDATE coordinator_events SET wake_lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [f.eventId],
    )
    const claim = await inbox.claim(f.owner)
    assert.ok(claim && 'delivery' in claim)
    await inbox.take(f.owner, `replacement-${randomUUID()}`, claim.delivery)
    execFileSync('docker', ['kill', '--signal', 'KILL', 'mikka176-sdk-next'], { stdio: 'ignore' })
    execFileSync('docker', ['start', 'mikka176-sdk-next'], { stdio: 'ignore' })
    await ready()
    // This case tests cached-step replay, not Local World's lost in-memory sleep timer.
    // Explicit SDK wakeUp drives replay after restart; the ordinary inbox sweep and
    // crash-mid-publication recovery are tested separately without this wakeUp.
    await run.wakeUp()
    log({ phase: 'explicit actual SDK wakeUp replay driver after restart', runId: run.runId })
    await wait(async () => ['completed', 'failed', 'cancelled'].includes(await run.status), 'actual replay terminal')
    const steps = await stepList(run),
      status = await run.status,
      memory = (await pool.query('SELECT memory FROM coordinator_sessions WHERE "userId"=$1', [f.owner])).rows[0]
        .memory,
      messages = (
        await pool.query('SELECT count(*)::int n FROM run_messages WHERE "mailboxId"=$1', [f.target.mailboxId])
      ).rows[0].n
    assert.equal(
      steps.filter((s) => s.stepName === registered.assertWakeCurrent.stepId && s.status === 'completed').length,
      1,
    )
    assert.ok(steps.some((s) => s.stepName === effect.stepId))
    log({
      phase: 'actual SDK cached guard replay after real Next restart and PG holder takeover',
      name,
      eventId: f.eventId,
      runId: run.runId,
      status,
      memoryUnchanged: memory === 'preserve original note',
      messageWrites: messages,
      steps: steps.map((s) => ({ name: s.stepName, status: s.status })),
    })
    if (before) {
      if (status === 'completed' && (memory !== 'preserve original note' || messages > 0)) reproduced++
    } else {
      assert.equal(status, 'failed')
      assert.equal(memory, 'preserve original note')
      assert.equal(messages, 0)
      assert.ok(steps.some((s) => s.stepName === effect.stepId && s.status === 'failed'))
    }
  }
  if (before) {
    assert.equal(reproduced, 3)
    log({
      result: 'REPRODUCED three unsafe stale effects in actual old compiled SDK steps; expected regression failure',
      reproduced,
    })
    process.exitCode = 1
  } else {
    const f = await fixture(),
      source =
        'async function workflow(input){"use workflow";await steps.effect(input.owner,input.holder,input.delivery,"remember",[{note:"fresh SDK effect"}]);return steps.effect(input.owner,input.holder,input.delivery,"mailboxAction",["send",input.send]);}'
    const run = await start(
      source,
      [
        {
          owner: f.owner,
          holder: f.holder,
          delivery: f.delivery,
          send: { to: f.target.mailboxId, key: randomUUID(), text: 'fresh SDK internal message' },
        },
      ],
      { experimental_dynamic: { steps: { effect: registered.executeWakeTool } } },
    )
    runs.push(run)
    await wait(async () => ['completed', 'failed'].includes(await run.status), 'fresh actual effect')
    assert.equal(await run.status, 'completed')
    assert.equal(
      (await pool.query('SELECT count(*)::int n FROM run_messages WHERE "mailboxId"=$1', [f.target.mailboxId])).rows[0]
        .n,
      1,
    )
    assert.equal(
      Object.keys(
        (await pool.query('SELECT wake_tool_receipts FROM coordinator_events WHERE id=$1', [f.eventId])).rows[0]
          .wake_tool_receipts,
      ).length,
      2,
    )
    log({
      result:
        'PASS actual SDK cached-step replay rejects stale remember/forget/mailbox effects; fresh compiled effect steps succeed atomically',
      eventId: f.eventId,
      runId: run.runId,
      cloudWorkflow: false,
      realModel: false,
    })
  }
} finally {
  for (const run of runs) {
    try {
      if (['pending', 'running'].includes(await run.status)) await run.cancel()
    } catch {}
  }
  await pool.end()
  await members.end()
}
