import { seedFixtureWorkspace } from './helpers/task-workspace'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { disposableDatabase } from './helpers/e2e-target.mjs'

// Only a disposable loopback *_e2e database is admissible; required in CI.
const enabled = disposableDatabase()
if (process.env.REQUIRE_DB === '1' && !enabled) throw new Error('Thread detail bytes test requires a loopback *_e2e database')

// Result JSON of every statement either pool runs while counting (as lib/db/egress-sample measures it).
let counting: { bytes: number } | null = null
const query = pg.Client.prototype.query
pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
  const tally = counting
  if (!tally) return Reflect.apply(query, this, args)
  const add = (value: { rows?: unknown[] } | undefined) => { tally.bytes += value?.rows?.length ? Buffer.byteLength(JSON.stringify(value.rows)) : 0 }
  // pg-pool passes a callback; checked-out clients use the promise.
  const callback = args.at(-1)
  if (typeof callback === 'function') return Reflect.apply(query, this, [...args.slice(0, -1), (error: unknown, value: { rows?: unknown[] }) => { if (!error) add(value); return callback(error, value) }])
  const result = Reflect.apply(query, this, args) as Promise<{ rows?: unknown[] }> | undefined
  result?.then?.(add, () => undefined)
  return result
} as typeof pg.Client.prototype.query
async function measured<T>(work: () => Promise<T>) {
  const tally = { bytes: 0 }
  counting = tally
  try { const value = await work(); await new Promise(resolve => setImmediate(resolve)); return { value, bytes: tally.bytes } }
  finally { counting = null }
}

test('an open thread\'s later reads leave its prompt and report in the database and show the same thread', { skip: !enabled, timeout: 120_000 }, async t => {
  const { pool } = await import('../lib/db')
  const { withActivitySession } = await import('./fixtures/activity-runtime.mjs')
  const { getIssueThread } = await import('../app/actions/agents')
  const { mergeThreadChunks } = await import('../lib/issue-run-conversation')
  const owner = `thread-detail-${randomUUID()}`
  const agent = randomUUID(), issue = randomUUID(), run = randomUUID()
  // A long prompt whose name is on its third line, and a report with large fields beside its summary.
  const prompt = `\n\n\`\`\`\n**Fix** the checkout rounding\n${'Context line with details. '.repeat(1_500)}`
  const instructions = '\n\nINTERNAL_HOST_GUIDANCE 🔍 must stay out of the user message.'
  const report = { runtime: { observedModel: 'observed-fixture' }, summary: '  Fixed the rounding.  ', files: 'diff '.repeat(8_000), notes: 'note '.repeat(4_000) }
  const as = <T>(work: () => Promise<T>) => withActivitySession(owner, work) as Promise<T>
  const chunk = (seq: number) => pool.query('insert into run_chunks(id,"runId",seq,chunk) values($1,$2,$3,$4)', [randomUUID(), run, seq, JSON.stringify({ type: 'text-delta', id: 't1', delta: `part ${seq} ` })])
  try {
    await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,true,now(),now())', [owner, `${owner}@example.invalid`])
    await pool.query('insert into agents(id,"userId",name,harness) values($1,$2,$3,$4)', [agent, owner, 'Fixture agent', 'codex'])
    await pool.query('insert into issues(id,"userId",title,content,status,priority,"workspaceId","ownershipState") values($1,$2,$3,$4,$5,$6,$7,\'bound\')', [issue, owner, 'Checkout task', JSON.stringify({ type: 'doc', content: [] }), 'doing', 'normal', await seedFixtureWorkspace(pool, owner)])
    await pool.query('insert into agent_runs(id,"userId","issueId","agentId",status,prompt,report,"promptTaskStart","promptTaskLength") values($1,$2,$3,$4,$5,$6,$7,0,$8)', [run, owner, issue, agent, 'running', prompt + instructions, JSON.stringify(report), Array.from(prompt).length])
    await pool.query(`UPDATE agent_runs SET "agentDefinition"=jsonb_build_object('model','selected-fixture') WHERE id=$1`, [run])
    for (let seq = 1; seq <= 3; seq++) await chunk(seq)

    const first = await measured(() => as(() => getIssueThread(issue, run)))
    assert.equal(first.value.thread.prompt, prompt, 'the first read shows the entire recorded user task')
    assert.equal(first.value.thread.detail?.name, 'Fix the checkout rounding')
    assert.equal(first.value.thread.detail?.summary, 'Fixed the rounding.')
    assert.equal(first.value.promptOmitted, undefined)
    assert.deepEqual(first.value.context?.composerModel, { selected: 'selected-fixture', served: 'observed-fixture' })
    assert.ok(first.bytes < prompt.length + JSON.stringify(report).length / 4, `the report's other fields stay in the database: ${first.bytes} B`)

    await chunk(4)
    const later = await measured(() => as(() => getIssueThread(issue, run, first.value.chunkCursor)))
    assert.equal(later.value.chunksAppend, true)
    assert.equal(later.value.promptOmitted, true)
    assert.equal(later.value.thread.prompt, '')
    assert.ok(later.bytes < prompt.length / 10, `a later read leaves the prompt in the database: ${later.bytes} B for a ${prompt.length}-character prompt`)

    // What the panel holds after merging equals a fresh read from the start.
    const merged = mergeThreadChunks(first.value, later.value)
    const fresh = await as(() => getIssueThread(issue, run))
    assert.equal(merged.promptOmitted, undefined)
    assert.deepEqual({ ...merged, live: undefined, chunksAppend: undefined }, { ...fresh, live: undefined, chunksAppend: undefined })
    assert.equal(merged.thread.detail?.name, 'Fix the checkout rounding')

    // A cursor the server cannot continue from reads everything again, prompt included.
    const stale = await as(() => getIssueThread(issue, run, { ...first.value.chunkCursor!, seq: 999 } as never))
    if (!stale.chunksAppend) assert.equal(stale.thread.prompt, prompt)
    t.diagnostic(JSON.stringify({ promptChars: prompt.length, reportJsonBytes: JSON.stringify(report).length, firstReadJsonBytes: first.bytes, laterReadJsonBytes: later.bytes }))
  } finally {
    await pool.query('delete from run_chunks where "runId"=$1', [run])
    await pool.query('delete from agent_runs where id=$1', [run])
    await pool.query('delete from issues where id=$1', [issue])
    await pool.query('delete from agents where id=$1', [agent])
    await pool.query('delete from mikka_workspace_members where "userId"=$1', [owner])
    await pool.query('delete from mikka_workspaces where "userId"=$1', [owner])
    await pool.query('delete from "user" where id=$1', [owner])
  }
})
