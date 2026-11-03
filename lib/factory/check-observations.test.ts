import assert from 'node:assert/strict'
import test from 'node:test'
import type { PoolClient } from 'pg'
import { configureFactoryCheck, producerCommandObservations } from './checks'
import { randomUUID } from 'node:crypto'
import { dbUrl } from '../../tests/support/workspace-admin-db'
import type { FactoryTask } from './store'

test('independent delivery prompt carries host execution observations and usable file evidence, without producer credentials', async () => {
  const sha = 'a'.repeat(40)
  let prompt = ''
  const tx = { query: async (sql: string, args: unknown[]) => {
    if (sql.startsWith('SELECT c.*')) return { rows: [{ id: 'candidate', kind: 'deliverable', executionSha: sha,
      deviceId: 'device', deviceRepoId: 'repo', environment: 'device:device', repository: '/delivery', repoPath: '/delivery',
      remoteUrl: null, enabled: true, deviceKind: 'cloud', cloudOnline: true, harness: 'claude_code',
      harnesses: [{ harness: 'claude_code', installed: true }],
      producerExecution: { runId: 'producer', sessionId: 'native-session', status: 'succeeded', model: 'deepseek-flash', harness: 'claude_code', observedModel: null },
      producerDefinition: { apiKey: 'private-key-must-not-appear' }, producerReport: { summary: 'Produced the file.' },
    }] }
    if (sql.includes('FROM run_chunks i JOIN run_chunks o')) {
      assert.deepEqual(args, ['producer', 'native-session', 'owner', 'issue', 'candidate', 'task', sha])
      return { rows: [{ inputChunkId: 'input-id', outputChunkId: 'output-id', seq: 1, toolName: 'bash', inputJson: JSON.stringify({ command: 'git diff --check && git status --short' }), outputType: 'tool-output-available', outputJson: JSON.stringify({ exitCode: 0, output: ' M DELIVERY.txt' }), inputTruncated: false, outputTruncated: false }] }
    }
    if (sql.includes("UPDATE agent_runs SET kind='acceptance'")) prompt = args[2] as string
    return { rows: [], rowCount: 1 }
  } } as unknown as PoolClient
  await configureFactoryCheck(tx, { stage: 'verify', status: 'pending', candidateId: 'candidate', id: 'task', userId: 'owner', issueId: 'issue', attemptId: 'attempt' } as FactoryTask, 'check-run')
  assert.match(prompt, /Persisted producer command observations/)
  assert.match(prompt, /git diff --check/)
  assert.match(prompt, /input-id/)
  assert.match(prompt, /not the producer report/)
  assert.match(prompt, /may precede the host-retained deliverable commit/)
  assert.match(prompt, /mikka\.inspect_artifact/)
  assert.match(prompt, /independent observations from the granted artifact or computer tools/)
  assert.doesNotMatch(prompt, /using real commands and observations/)
  assert.match(prompt, /If a criterion explicitly requires independent command execution, report the missing capability/)
  assert.match(prompt, /contentUtf8/)
  assert.match(prompt, /expectedUtf8/)
  assert.match(prompt, /Do not pass a criterion from the producer report alone/)
  assert.doesNotMatch(prompt, /Use the granted mikka\.verify_command tool/)
  assert.match(prompt, /"runId":"producer".*"sessionId":"native-session".*"model":"deepseek-flash".*"harness":"claude_code"/)
  assert.match(prompt, /not a provider billing log or proof of an alias version/)
  assert.match(prompt, /Missing observations are not observed mismatches/)
  assert.doesNotMatch(prompt, /private-key-must-not-appear/)
})


test('isolated PG: producer command records bind owner/session/candidate and retain actual results, never self-reported success', { skip: !dbUrl }, async () => {
  const { Pool } = await import('pg')
  const admin = new Pool({ connectionString: dbUrl, max: 1 })
  const schema = 'producer_observations_' + randomUUID().replaceAll('-', '')
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const db = new Pool({ connectionString: dbUrl, options: `-c search_path=${schema}`, max: 1 })
  try {
    // Isolated real SQL/provenance boundaries; the native events themselves
    // are synthetic fixtures, not a live provider acceptance.
    await db.query(`CREATE TABLE agent_runs (id uuid PRIMARY KEY,"userId" text,"issueId" uuid,"sessionId" text,status text,"startedAt" timestamptz,"finishedAt" timestamptz,report jsonb);
      CREATE TABLE factory_tasks (id uuid PRIMARY KEY,"userId" text,"issueId" uuid);
      CREATE TABLE factory_candidates (id uuid PRIMARY KEY,"taskId" uuid,"runId" uuid,kind text,sha text);
      CREATE TABLE run_chunks (id uuid PRIMARY KEY,"runId" uuid,seq int,chunk jsonb,"createdAt" timestamptz)`)
    const task = { id: randomUUID(), userId: 'fixture-owner', issueId: randomUUID() }
    const producer = { runId: randomUUID(), sessionId: 'native-fixture-session' }
    const candidate = { id: randomUUID(), executionSha: 'b'.repeat(40), producerExecution: producer }
    await db.query(`INSERT INTO agent_runs VALUES ($1,$2,$3,$4,'succeeded',now()-interval '20 seconds',now()-interval '2 seconds',$5)`, [producer.runId, task.userId, task.issueId, producer.sessionId, JSON.stringify({ deliverableCommit: candidate.executionSha })])
    await db.query('INSERT INTO factory_tasks VALUES ($1,$2,$3)', [task.id, task.userId, task.issueId])
    await db.query(`INSERT INTO factory_candidates VALUES ($1,$2,$3,'deliverable',NULL)`, [candidate.id, task.id, producer.runId])
    const insert = async (seq: number, chunk: unknown, timing = "now()-interval '10 seconds'") => db.query(`INSERT INTO run_chunks VALUES ($1,$2,$3,$4,${timing})`, [randomUUID(), producer.runId, seq, JSON.stringify(chunk)])
    await insert(1, { type: 'tool-input-available', toolName: 'bash', toolCallId: 'head', input: { command: 'git rev-parse HEAD' } })
    await insert(2, { type: 'tool-output-available', toolCallId: 'head', output: { exitCode: 0, output: 'a'.repeat(40) } })
    await insert(3, { type: 'tool-input-available', toolName: 'Bash', toolCallId: 'scope', input: { command: 'git diff --check && git status --short' } })
    await insert(4, { type: 'tool-output-available', toolCallId: 'scope', output: { exitCode: 7, output: ' M DELIVERY.txt\npassword=private-must-not-appear' } })
    await insert(5, { type: 'tool-input-available', toolName: 'bash', toolCallId: 'unpaired', input: { command: 'unpaired observation' } })
    await insert(6, { type: 'tool-output-available', toolCallId: 'different-call', output: { exitCode: 0, output: 'not a matching result' } })
    await insert(7, { type: 'tool-input-available', toolName: 'bash', toolCallId: 'late', input: { command: 'outside the finished native run' } })
    await insert(8, { type: 'tool-output-available', toolCallId: 'late', output: { exitCode: 0 } }, 'now()')
    const raw = await producerCommandObservations(db, task, candidate)
    const observed = JSON.parse(raw)
    assert.equal(observed.records.length, 2)
    assert.equal(observed.producerSessionId, producer.sessionId)
    assert.equal(observed.candidateSha, candidate.executionSha)
    assert.equal(observed.records[0].output.output, 'a'.repeat(40), 'the producer pre-retention HEAD stays unchanged')
    assert.equal(observed.records[1].output.exitCode, 7, 'failed native output is not converted to success')
    assert.doesNotMatch(raw, /private-must-not-appear|not a matching result|outside the finished native run/)
    for (const [scope, bound] of [
      [{ ...task, userId: 'other-owner' }, candidate],
      [{ ...task, issueId: randomUUID() }, candidate],
      [task, { ...candidate, id: randomUUID() }],
      [task, { ...candidate, executionSha: 'c'.repeat(40) }],
      [task, { ...candidate, producerExecution: { ...producer, sessionId: 'different-session' } }],
    ] as const) assert.deepEqual(JSON.parse(await producerCommandObservations(db, scope, bound)).records, [])
    await insert(9, { type: 'tool-input-available', toolName: 'bash', toolCallId: 'large', input: { command: 'x'.repeat(4100) + 'password=hidden-large-secret' } })
    await insert(10, { type: 'tool-output-available', toolCallId: 'large', output: { exitCode: 0, output: 'x'.repeat(6100) + 'password=hidden-large-secret' } })
    const limited = JSON.parse(await producerCommandObservations(db, task, candidate))
    const large = limited.records.at(-1)
    assert.deepEqual([large.input, large.output, large.inputTruncated, large.outputTruncated], [null, null, true, true])
    assert.doesNotMatch(JSON.stringify(limited), /hidden-large-secret/)
    for (let i = 0; i < 34; i++) {
      await insert(11 + 2 * i, { type: 'tool-input-available', toolName: 'bash', toolCallId: `many-${i}`, input: { command: 'x'.repeat(900) } })
      await insert(12 + 2 * i, { type: 'tool-output-available', toolCallId: `many-${i}`, output: { exitCode: 0 } })
    }
    const bounded = await producerCommandObservations(db, task, candidate)
    assert.ok(bounded.length < 24200)
    assert.match(bounded, /"earlierRecordsOmitted":true/)
    assert.match(bounded, /Producer command observations truncated; missing observations cannot establish a pass/)
  } finally {
    await db.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
