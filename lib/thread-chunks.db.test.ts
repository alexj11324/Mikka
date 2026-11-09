import { seedFixtureWorkspace } from '../tests/helpers/task-workspace'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Socket } from 'node:net'
import test from 'node:test'
import { disposableDatabase } from '../tests/helpers/e2e-target.mjs'

// Only a disposable loopback *_e2e database is admissible; required in CI.
const required = process.env.REQUIRE_DB === '1'
const enabled = disposableDatabase()
if (required && !enabled) throw new Error('Thread chunk DB test requires a loopback *_e2e database')

// Every byte the database sends to this process.
const sockets = new Set<Socket>()
const connect = Socket.prototype.connect
Socket.prototype.connect = function (this: Socket, ...args: unknown[]) {
  sockets.add(this)
  return Reflect.apply(connect, this, args)
} as typeof Socket.prototype.connect
const received = () => [...sockets].reduce((sum, socket) => sum + socket.bytesRead, 0)
async function measured<T>(work: () => Promise<T>) {
  const before = received()
  const value = await work()
  return { value, bytes: received() - before }
}

test('a thread read with a cursor returns only later chunks, and reads everything when appending would be wrong', { skip: !enabled }, async t => {
  const { pool } = await import('./db')
  const { readThreadChunks } = await import('./thread-chunks')
  const user = `thread-chunks-${randomUUID()}`, agent = randomUUID(), first = randomUUID(), second = randomUUID()
  const text = 'tool output '.repeat(80)
  const insert = (runId: string, seqs: number[]) => pool.query(
    `insert into run_chunks (id,"runId",seq,chunk) select gen_random_uuid(), $1, s, jsonb_build_object('type','text-delta','id','t'||s,'delta',$3::text) from unnest($2::int[]) s`,
    [runId, seqs, text])
  const seqs = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => from + index)
  try {
    await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,false,now(),now())', [user, `${user}@example.invalid`])
    await pool.query('insert into agents (id,"userId",harness,name) values ($1,$2,\'codex\',\'Chunks\')', [agent, user])
    const workspaceId = await seedFixtureWorkspace(pool, user)
    await pool.query('insert into agent_runs (id,"userId","agentId","workspaceId",status,"createdAt") values ($1,$3,$4,$5,\'running\',now()-interval \'1 minute\'),($2,$3,$4,$5,\'queued\',now())', [first, second, user, agent, workspaceId])
    // 200 chunks of about 1 KB, with seq 150 held back: a batch stored after later ones.
    await insert(first, seqs(0, 200).filter(seq => seq !== 150))

    const full = await measured(() => readThreadChunks([first], null))
    assert.equal(full.value.append, false)
    assert.equal(full.value.chunks.length, 199)
    assert.deepEqual(full.value.cursor, { chain: first, runId: first, seq: 199, runs: 1, count: 199 })

    // Nothing new: an empty append, a few bytes.
    const quiet = await measured(() => readThreadChunks([first], full.value.cursor))
    assert.equal(quiet.value.append, true)
    assert.equal(quiet.value.chunks.length, 0)
    assert.deepEqual(quiet.value.cursor, full.value.cursor)

    // Three new chunks: only those.
    await insert(first, [200, 201, 202])
    const more = await measured(() => readThreadChunks([first], quiet.value.cursor))
    assert.equal(more.value.append, true)
    assert.deepEqual(more.value.chunks.map(row => row.chunk.id), ['t200', 't201', 't202'])
    assert.deepEqual(more.value.cursor, { chain: first, runId: first, seq: 202, runs: 1, count: 202 })
    t.diagnostic(JSON.stringify({ chunks: 199, fullReadDbBytes: full.bytes, quietReadDbBytes: quiet.bytes, threeNewChunksDbBytes: more.bytes }))
    assert.ok(quiet.bytes * 20 < full.bytes && more.bytes * 10 < full.bytes)

    // The held-back batch lands below the cursor: the counts differ, so everything is read again.
    await insert(first, [150])
    const late = await readThreadChunks([first], more.value.cursor)
    assert.equal(late.append, false)
    assert.equal(late.chunks.length, 203)
    assert.equal(late.chunks[150].chunk.id, 't150')

    // The thread runs again (R-81): a new chain is read whole; the second run's chunks rename every id.
    await insert(second, [0, 1])
    const chained = await readThreadChunks([first, second], late.cursor)
    assert.equal(chained.append, false)
    assert.equal(chained.chunks.length, 205)
    assert.equal(chained.chunks[0].chunk.id, `${first}:t0`)
    assert.equal(chained.chunks.at(-1)?.chunk.id, `${second}:t1`)
    // Once the chain spans both runs, appended chunks carry the same per-run ids.
    await insert(second, [2])
    const appended = await readThreadChunks([first, second], chained.cursor)
    assert.equal(appended.append, true)
    assert.deepEqual(appended.chunks.map(row => row.chunk.id), [`${second}:t2`])

    // A cursor for other runs never appends.
    const other = await readThreadChunks([second], appended.cursor)
    assert.equal(other.append, false)
    assert.equal(other.chunks.length, 3)
  } finally {
    await pool.query('delete from agent_runs where "userId"=$1', [user])
    await pool.query('delete from agents where "userId"=$1', [user])
    await pool.query('delete from "user" where id=$1', [user])
  }
})
