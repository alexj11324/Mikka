/**
 * Issue 1503: isolated PostgreSQL wire-response comparison.
 * Copy to scripts/ops/issue1503/handoff-wire-bytes.mts in the tested checkout.
 * Preparation only: this file must never target a shared or production DB.
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { Pool, type PoolClient, type QueryResult } from 'pg'

const BASELINE_SHA = 'c563af107a6cb7aaabce996b1eda9d9b53508a99'
const JSON_SHA = '3465d9a686a827342344cc62e02195a8c5ad435c'
const SOURCE_PATH = 'lib/factory/handoff.ts'

type WireClient = PoolClient & { connection: { stream: { bytesRead: number; encrypted?: boolean; remoteAddress?: string } } }
type SelectSample = { responseBytes: number; commands: string[]; rows: number[]; protocol: 'simple' | 'extended' }
type HandoffFunction = (tx: Pick<PoolClient, 'query'>, task: any) => Promise<any>

/** The client is dedicated to one invocation, with no unrelated queued queries.
 * node-postgres resolves a query after ReadyForQuery, so a socket counter delta
 * covers its response, including protocol framing, but no seed/transaction I/O.
 */
async function measureHandoff(client: WireClient, invoke: HandoffFunction, task: any) {
  const samples: SelectSample[] = []
  const otherCommands: string[] = []
  let inFlight = false
  const observed = {
    query: async (...args: any[]) => {
      assert.equal(inFlight, false, 'measurement requires serial use of its dedicated client')
      const first = args[0]
      const sql = typeof first === 'string' ? first : first?.text
      assert.equal(typeof sql, 'string', 'unsupported query shape')
      const isSelect = /^\s*(?:SELECT|WITH)\b/i.test(sql)
      const values = typeof first === 'object' ? first.values : args[1]
      const protocol = values?.length || (typeof first === 'object' && (first.name || first.queryMode === 'extended')) ? 'extended' : 'simple'
      inFlight = true
      const before = client.connection.stream.bytesRead
      try {
        const answer = await (client.query as any)(...args)
        const after = client.connection.stream.bytesRead
        const results: QueryResult[] = Array.isArray(answer) ? answer : [answer]
        assert.ok(after >= before, 'socket bytesRead must be monotonic')
        if (isSelect) {
          assert.ok(results.every(result => result.command === 'SELECT'), 'history query must only return SELECT results')
          samples.push({ responseBytes: after - before, commands: results.map(result => result.command),
            rows: results.map(result => result.rowCount ?? 0), protocol })
        } else {
          otherCommands.push(...results.map(result => result.command))
        }
        return answer
      } finally { inFlight = false }
    },
  } as Pick<PoolClient, 'query'>
  const handoff = await invoke(observed, task)
  return { handoff, selectCalls: samples.length, responseBytes: samples.reduce((n, sample) => n + sample.responseBytes, 0),
    resultCommands: samples.flatMap(sample => sample.commands), rowCounts: samples.flatMap(sample => sample.rows), samples, otherCommands }
}

function gitSource(root: string, ref: string): Buffer {
  assert.match(ref, /^[a-f0-9]{40}$/)
  return execFileSync('git', ['show', `${ref}:${SOURCE_PATH}`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
}

function boundedText(kind: 'ordinary' | 'json_code' | 'escaped_boundary'): string {
  if (kind === 'ordinary') return 'Keep the exact task scope. Verify the current repository and retain the owner instructions.\n'.repeat(8)
  if (kind === 'json_code') return 'const example = { "path": "src/file.ts", "value": "quoted" };\nif (example.value) { console.log(JSON.stringify(example)); }\n'.repeat(60).slice(0, 9000)
  return '"\\\n'.repeat(3334).slice(0, 10000)
}

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const load = (root: string, path: string) => import(pathToFileURL(resolve(root, path)).href)

function isolatedDatabase(): string {
  const url = process.env.E2E_DATABASE_URL
  assert.ok(url, 'wire_isolated_database_required')
  const target = new URL(url)
  assert.ok(['postgres:', 'postgresql:'].includes(target.protocol), 'wire_postgresql_required')
  assert.equal(target.hostname, '127.0.0.1', 'wire_loopback_tcp_required')
  assert.match(target.pathname, /^\/[A-Za-z0-9_]+_e2e$/, 'wire_test_database_required')
  assert.equal(target.search, '', 'wire_database_url_options_forbidden')
  assert.equal(process.env.DATABASE_URL, url, 'wire_database_targets_must_match')
  assert.equal(process.env.MIKKA_DATABASE_URL, url, 'wire_database_targets_must_match')
  assert.equal(process.env.REQUIRE_DB, '1', 'wire_required_database_gate')
  return url
}

function safeError(error: unknown) {
  const value = error as { name?: unknown; code?: unknown; message?: unknown }
  const name = typeof value?.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(value.name) ? value.name : 'Error'
  const code = typeof value?.code === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(value.code) ? value.code : undefined
  // Only an explicit assertion label is retained; no pg message, SQL, URL,
  // password, assertion values, source text or stack crosses into the report.
  const assertion = typeof value?.message === 'string' ? value.message.match(/\bwire_[a-z_]+\b/)?.[0] : undefined
  return { name, ...(code ? { code } : {}), ...(assertion ? { assertion } : {}) }
}

function summary(measured: Awaited<ReturnType<typeof measureHandoff>>) {
  const { handoff, ...wire } = measured
  return { ...wire, totalQueryCalls: wire.selectCalls + wire.otherCommands.length,
    digest: handoff.digest, eventId: handoff.eventId, handoffSha256: sha256(JSON.stringify(handoff)) }
}

/** Same fixture family as continuity.db.test.ts, with real dates, a checkpoint,
 * publication JSON and ledger JSON. Empty effects/questions remain real SELECT
 * result sets (with RowDescription and CommandComplete), not omitted mocks.
 */
async function seedFixture(pool: Pool, helpers: any, store: any, owner: string, workspaceId: string, agentId: string, text: string) {
  const issueId = await helpers.seedIssue(pool, owner)
  const sourceEventId = randomUUID()
  const instant = '2026-11-06T18:29:59.123456Z'
  await pool.query(`INSERT INTO coordinator_events(id,"userId","issueId",kind,"dedupeKey",payload,"createdAt")
    VALUES($1::uuid,$2,$3,'user_message',$1::text,$4,$5)`,
  [sourceEventId, owner, issueId, JSON.stringify({ text }), instant])
  const { task } = await store.route(owner, { issueId, sourceEventId, eventId: randomUUID(), rationale: 'Isolated wire response fixture', needsSpec: false })
  assert.equal(task.stage, 'execute', 'wire_fixture_must_not_request_approved_specification')
  const runId = await helpers.seedRun(pool, { userId: owner, agentId, issueId, status: 'succeeded', finishedAt: new Date(instant) })
  const candidateId = randomUUID()
  await pool.query(`UPDATE agent_runs SET "stopReason"='submitted',"sessionId"='wire-fixture-session',"finishedAt"=$2 WHERE id=$1`, [runId, instant])
  await pool.query(`INSERT INTO factory_candidates(id,"taskId",sha,repository,environment,scope,"runId","createdAt")
    VALUES($1,$2,$3,'fixture/repository','isolated-test','fixture only',$4,$5)`, [candidateId, task.id, 'a'.repeat(40), runId, instant])
  await pool.query(`UPDATE factory_attempts SET "runId"=$2,status='passed',"candidateId"=$3,"finishedAt"=$4,output=$5 WHERE id=$1`,
    [task.attemptId, runId, candidateId, instant, JSON.stringify({ requestEpoch: sourceEventId })])
  await pool.query(`UPDATE factory_tasks SET status='passed',"candidateId"=$2 WHERE id=$1`, [task.id, candidateId])
  await pool.query(`INSERT INTO run_checkpoints("runId","userId","baseCommit",patch,files,"takenAt","updatedAt")
    VALUES($1,$2,$3,$4,2,$5,$5)`, [runId, owner, 'b'.repeat(40), Buffer.alloc(0), instant])
  await pool.query(`INSERT INTO run_publications("runId","userId","issueId","remoteUrl","remoteKey",branch,status,"pullRequest","updatedAt")
    VALUES($1,$2,$3,'https://example.invalid/fixture/repository.git','fixture/repository','mikka/fixture','published',$4,$5)`,
    [runId, owner, issueId, JSON.stringify({ url: 'https://example.invalid/fixture/1', state: 'open', title: 'Synthetic wire fixture', updatedAt: instant }), instant])
  const uncertain = randomUUID(), succeeded = randomUUID()
  await pool.query(`INSERT INTO operation_ledger("operationId","ownerId","workspaceId",binding,"idempotencyKey",status,"attemptToken","runId","updatedAt")
    VALUES($1,$2,$3,$4,$5,'uncertain',$6,$7,$8)`,
    [uncertain, owner, workspaceId, JSON.stringify({ executionRunId: runId, action: 'fixture_observation', target: 'fixture-only' }),
      `wire:${uncertain}`, randomUUID(), runId, instant])
  await pool.query(`INSERT INTO operation_ledger("operationId","ownerId","workspaceId",binding,"idempotencyKey",status,"attemptToken","runId",receipt,"updatedAt")
    VALUES($1,$2,$3,$4,$5,'succeeded',$6,$7,$8,$9)`,
    [succeeded, owner, workspaceId, JSON.stringify({ executionRunId: runId, action: 'fixture_observation' }),
      `wire:${succeeded}`, randomUUID(), runId, JSON.stringify({ nested: { updatedAt: instant }, note: 'A "quoted" fixture\\path\nline.' }), instant])
  return { ...task, status: 'passed', candidateId }
}

async function cleanFixture(pool: Pool, owner: string) {
  // Every predicate names only this invocation's random fixture owner.
  await pool.query('DELETE FROM operation_ledger WHERE "ownerId"=$1', [owner])
  await pool.query('DELETE FROM factory_tasks WHERE "userId"=$1', [owner])
  await pool.query('DELETE FROM coordinator_events WHERE "userId"=$1', [owner])
  await pool.query('DELETE FROM agent_runs WHERE "userId"=$1', [owner])
  await pool.query('DELETE FROM agents WHERE "userId"=$1', [owner])
  await pool.query('DELETE FROM issues WHERE "userId"=$1', [owner])
  await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId" IN (SELECT id FROM mikka_workspaces WHERE "userId"=$1)', [owner])
  await pool.query('DELETE FROM mikka_workspaces WHERE "userId"=$1', [owner])
  await pool.query('DELETE FROM "user" WHERE id=$1', [owner])
  const { rows: [left] } = await pool.query(`SELECT
    (SELECT count(*) FROM operation_ledger WHERE "ownerId"=$1) +
    (SELECT count(*) FROM factory_tasks WHERE "userId"=$1) +
    (SELECT count(*) FROM coordinator_events WHERE "userId"=$1) +
    (SELECT count(*) FROM agent_runs WHERE "userId"=$1) +
    (SELECT count(*) FROM agents WHERE "userId"=$1) +
    (SELECT count(*) FROM issues WHERE "userId"=$1) +
    (SELECT count(*) FROM mikka_workspaces WHERE "userId"=$1) +
    (SELECT count(*) FROM "user" WHERE id=$1) AS remaining`, [owner])
  assert.equal(Number(left.remaining), 0, 'wire_fixture_cleanup_incomplete')
  return { remainingOwnerRows: 0, cascadedTaskAndRunChildren: true }
}

async function main() {
  const root = resolve(process.cwd())
  const output = resolve(root, process.env.MIKKA_1503_WIRE_REPORT ?? 'issue1503-wire-report/handoff-wire-bytes.json')
  assert.ok(!relative(root, output).startsWith('..'), 'wire_report_must_stay_in_checkout')
  const report: any = { version: 1, status: 'running', phase: 'preflight', source: {}, measurements: [], cleanup: { errors: [] },
    method: { transport: 'dedicated non-TLS loopback TCP PoolClient', counter: 'connection.stream.bytesRead',
      includes: 'PostgreSQL response protocol bytes through ReadyForQuery',
      excludes: ['seed SQL', 'BEGIN/SAVEPOINT/ROLLBACK', 'event INSERT', 'identity/version queries', 'client request bytes', 'TCP/IP/TLS overhead'],
      snapshot: 'one repeatable-read transaction per case; each module invocation is rolled back to a savepoint',
      productionAcceptance: false } }
  const temporary: string[] = []
  const pools = new Set<Pool>()
  let seedPool: Pool | undefined, wirePool: Pool | undefined, owner: string | undefined
  let primaryFailure: unknown
  try {
    const connectionString = isolatedDatabase()
    assert.equal(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim(), root, 'wire_checkout_root_required')
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    assert.match(head, /^[a-f0-9]{40}$/)
    if (process.env.GITHUB_SHA) assert.equal(head, process.env.GITHUB_SHA, 'wire_checkout_sha_mismatch')
    const candidateBytes = await readFile(resolve(root, SOURCE_PATH))
    assert.equal(sha256(candidateBytes), sha256(gitSource(root, head)), 'wire_candidate_must_match_commit')
    report.source = { checkoutSha: head, candidate: { path: SOURCE_PATH, sha256: sha256(candidateBytes) }, baselineSha: BASELINE_SHA }
    const variants: Array<{ name: string; invoke: HandoffFunction }> = []
    for (const [name, ref] of [['baseline', BASELINE_SHA], ...(process.env.MIKKA_1503_WIRE_JSON === '1' ? [['jsonAggregate', JSON_SHA]] : [])]) {
      const bytes = gitSource(root, ref)
      const path = resolve(root, `lib/factory/handoff.wire-${name}-${randomUUID()}.ts`)
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
      temporary.push(path)
      const module = await import(pathToFileURL(path).href)
      assert.equal(typeof module.persistFactoryHandoff, 'function', 'wire_handoff_export_missing')
      variants.push({ name, invoke: module.persistFactoryHandoff })
      report.source[name] = { commit: ref, path: SOURCE_PATH, sha256: sha256(bytes) }
    }
    const candidate = await load(root, SOURCE_PATH)
    variants.splice(1, 0, { name: 'candidate', invoke: candidate.persistFactoryHandoff })

    report.phase = 'database_identity'
    const poolOptions = { connectionString, ssl: false as const, connectionTimeoutMillis: 10_000, statement_timeout: 15_000 }
    seedPool = new Pool({ ...poolOptions, max: 2, application_name: 'issue1503-wire-fixture' }); pools.add(seedPool)
    wirePool = new Pool({ ...poolOptions, max: 1, application_name: 'issue1503-wire-measure' }); pools.add(wirePool)
    const { rows: [database] } = await seedPool.query(`SELECT current_setting('server_version_num')::int AS version,
      current_database() AS name`)
    assert.ok(database.version >= 170000 && database.version < 180000, 'wire_postgresql_seventeen_required')
    assert.equal(database.name, new URL(connectionString).pathname.slice(1), 'wire_database_identity_mismatch')
    // GitHub service containers are reached through a loopback published port;
    // inet_server_addr() inside PostgreSQL can be the container's private IP.
    // The URL and actual client socket are the local-target boundary instead.
    report.database = { major: 17, versionNum: database.version, loopback: true, tls: false, dedicatedClient: true }

    report.phase = 'fixture_setup'
    const helpers = await load(root, 'tests/support/workspace-admin-db.ts')
    const { pool: appPool } = await load(root, 'lib/db/index.ts'); pools.add(appPool)
    const { workspacePool } = await load(root, 'lib/workspace-db.ts'); pools.add(workspacePool)
    const { createFactoryStore } = await load(root, 'lib/factory/store.ts')
    owner = await helpers.seedUser(seedPool, 'factory-wire-1503')
    const workspace = await helpers.seedWorkspace(seedPool, owner, [{ userId: owner, role: 'admin' }])
    const agentId = await helpers.seedAgent(seedPool, owner)
    const store = createFactoryStore(seedPool, async (user: string, issue: string, tx: PoolClient) =>
      user === owner && Boolean((await tx.query('SELECT id FROM issues WHERE id=$1 AND "userId"=$2', [issue, user])).rowCount), null, {})

    for (const kind of ['ordinary', 'json_code', 'escaped_boundary'] as const) {
      report.phase = `seed_${kind}`
      const text = boundedText(kind)
      assert.ok(text.length <= 10000, 'wire_source_text_limit')
      if (kind === 'escaped_boundary') assert.equal(text.length, 10000, 'wire_boundary_length_required')
      const task = await seedFixture(seedPool, helpers, store, owner!, workspace.id, agentId, text)
      const row: any = { case: kind, sourceTextCharacters: text.length, sourceTextUtf8Bytes: Buffer.byteLength(text),
        sourceTextSha256: sha256(text), modules: {}, comparisons: {} }
      report.measurements.push(row)
      const client = await wirePool.connect() as WireClient
      let transactionOpen = false
      try {
        assert.equal(client.connection.stream.encrypted, undefined, 'wire_tls_not_allowed')
        assert.ok(['127.0.0.1', '::ffff:127.0.0.1'].includes(client.connection.stream.remoteAddress ?? ''), 'wire_tcp_client_must_be_loopback')
        assert.ok(Number.isSafeInteger(client.connection.stream.bytesRead), 'wire_socket_counter_required')
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
        transactionOpen = true
        // Fix the snapshot before any measured SELECT, and prove that this is
        // still the same owned source. The probe is explicitly not measured.
        const { rows: [frozen] } = await client.query(`SELECT e.payload->>'text' AS text FROM coordinator_events e
          JOIN factory_tasks t ON t."sourceEventId"=e.id WHERE t.id=$1 AND t."userId"=$2`, [task.id, owner])
        assert.equal(sha256(frozen.text), sha256(text), 'wire_fixture_snapshot_mismatch')
        let baseline: Awaited<ReturnType<typeof measureHandoff>> | undefined
        for (const variant of variants) {
          report.phase = `measure_${kind}_${variant.name}`
          await client.query('SAVEPOINT wire_invocation')
          let measured: Awaited<ReturnType<typeof measureHandoff>>
          try { measured = await measureHandoff(client, variant.invoke, task) }
          finally { await client.query('ROLLBACK TO SAVEPOINT wire_invocation'); await client.query('RELEASE SAVEPOINT wire_invocation') }
          row.modules[variant.name] = summary(measured)
          assert.deepEqual(measured.otherCommands, ['INSERT'], 'wire_only_handoff_insert_may_be_unmeasured')
          if (variant.name === 'baseline') {
            baseline = measured
            assert.equal(measured.selectCalls, 6, 'wire_baseline_requires_six_queries')
            assert.deepEqual(measured.resultCommands, Array(6).fill('SELECT'), 'wire_baseline_requires_six_results')
            assert.deepEqual(measured.rowCounts, [1, 1, 0, 1, 2, 0], 'wire_fixture_result_shape_changed')
          } else {
            assert.ok(baseline, 'wire_baseline_missing')
            row.comparisons[variant.name] = { handoffEqual: isDeepStrictEqual(measured.handoff, baseline.handoff),
              digestEqual: measured.handoff.digest === baseline.handoff.digest,
              responseByteDelta: measured.responseBytes - baseline.responseBytes }
            assert.ok(row.comparisons[variant.name].handoffEqual, 'wire_handoff_changed')
            assert.ok(row.comparisons[variant.name].digestEqual, 'wire_digest_changed')
            assert.equal(measured.selectCalls, 1, 'wire_candidate_requires_one_query')
            if (variant.name === 'candidate') {
              assert.deepEqual(measured.resultCommands, Array(6).fill('SELECT'), 'wire_candidate_requires_six_native_results')
              assert.deepEqual(measured.rowCounts, baseline.rowCounts, 'wire_native_row_counts_changed')
              assert.equal(measured.samples[0].protocol, 'simple', 'wire_native_simple_protocol_required')
              assert.ok(measured.responseBytes <= baseline.responseBytes, 'wire_candidate_response_bytes_increased')
            } else {
              assert.deepEqual(measured.resultCommands, ['SELECT'], 'wire_json_requires_one_aggregate_result')
              if (kind === 'escaped_boundary') assert.ok(measured.responseBytes > baseline.responseBytes, 'wire_json_expansion_not_reproduced')
            }
          }
        }
      } finally {
        try { if (transactionOpen) await client.query('ROLLBACK') }
        finally { client.release() }
      }
    }
    report.status = 'passed'
    report.phase = 'complete'
  } catch (error) {
    primaryFailure = error
    report.status = 'failed'
    report.error = safeError(error)
  } finally {
    if (seedPool && owner) {
      try { report.cleanup.fixture = await cleanFixture(seedPool, owner) }
      catch (error) { report.cleanup.errors.push({ stage: 'fixture', ...safeError(error) }) }
    }
    const closed = await Promise.allSettled([...pools].map(pool => pool.end()))
    report.cleanup.closedPools = closed.filter(row => row.status === 'fulfilled').length
    for (const result of closed) if (result.status === 'rejected') report.cleanup.errors.push({ stage: 'pool', ...safeError(result.reason) })
    for (const path of temporary) {
      try { await rm(path); report.cleanup.removedTemporaryModules = (report.cleanup.removedTemporaryModules ?? 0) + 1 }
      catch (error) { report.cleanup.errors.push({ stage: 'temporary_module', ...safeError(error) }) }
    }
    if (report.cleanup.errors.length) report.status = 'failed'
    await mkdir(resolve(output, '..'), { recursive: true })
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  }
  console.log(JSON.stringify({ status: report.status, report: relative(root, output), cases: report.measurements.length,
    cleanupErrors: report.cleanup.errors.length, ...(report.error ? { error: report.error, phase: report.phase } : {}) }))
  if (primaryFailure || report.status !== 'passed') process.exitCode = 1
}

await main()
