import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { options, remoteReceipt, run } from './cloud-native-mcp.mjs'
import { createHash } from 'node:crypto'

const id = '00000000-0000-4000-8000-000000000001', runId = '00000000-0000-4000-8000-000000000002'
const record = { runId, harness: 'codex', sampleId: 'case_codex' }
const prefix = `mcp__mcp_${id.replaceAll('-', '')}__`
const note = 'Repository topic facts: AI SDK wiki structure lists Architecture and Design Principles, Package Structure and Organization, and Model generation and tools. Documentation map: consult those sections for generation, tool execution and streaming integration. Recommendations: keep durable session ownership in Eve and task MCP configuration in the official CLI. These are integration recommendations based on topic names, not claims from unread topic contents. See https://deepwiki.com/vercel/ai. STARTUP_OK_case_codex'
const wrap = chunk => ({ at: '2026-11-11T01:00:00.000Z', chunk })
function fixture() {
  return { thread: { id: runId, rootRunId: runId, latestRunId: runId, ownedByCurrentUser: true, status: 'succeeded',
    continuation: null, attempts: [{ runId }], detail: { harness: 'codex' } }, chunks: [
    { type: 'data-run-stage', data: { stage: 'agent_start', ok: true } },
    { type: 'tool-input-available', toolName: prefix + 'read_wiki_structure', toolCallId: 'structure', input: { repoName: 'vercel/ai' } },
    { type: 'tool-output-available', toolCallId: 'structure', output: [{ type: 'text', text: '# AI SDK repository documentation\n1. Architecture and Design Principles\n2. Package Structure and Organization\n3. Model generation and tools' }] },
    { type: 'tool-input-available', toolName: 'mcp__mikka__submit', toolCallId: 'submit', input: { summary: note } },
    { type: 'tool-output-available', toolCallId: 'submit', output: { received: true } },
  ].map(wrap) }
}

test('one actual native structure result and later native handoff produce closed evidence only', () => {
  const receipt = remoteReceipt(fixture(), record, id)
  assert.equal(receipt.calls.length, 1)
  assert.equal(receipt.calls[0].tool, 'read_wiki_structure')
  assert.equal(receipt.serverName, `mcp_${id.replaceAll('-', '')}`)
  assert.equal(receipt.terminal, 'succeeded')
  assert.equal(receipt.handoff.successful, true)
  assert.match(receipt.handoff.summarySha256, /^[a-f0-9]{64}$/)
  assert.doesNotMatch(JSON.stringify(receipt), /AI SDK repository documentation|Repository topic facts|received|summary"/)
})

test('foreign server, partial output, absent handoff and early handoff never prove execution', () => {
  const foreign = fixture(); foreign.chunks[1].chunk.toolName = 'mcp__mcp_foreign__read_wiki_structure'
  const pending = fixture(); pending.chunks.splice(2, 1)
  const noCall = fixture(); noCall.chunks.splice(1, 2)
  const bareProse = fixture(); bareProse.chunks.splice(3, 2); bareProse.chunks.push(wrap({ type: 'text-delta', delta: note }))
  const early = fixture(); early.chunks.splice(1, 0, ...early.chunks.splice(3, 2))
  const active = fixture(); active.thread.status = 'running'
  const failed = fixture(); failed.chunks[2].chunk.type = 'tool-output-error'
  for (const detail of [foreign, pending, noCall, bareProse, early, active, failed]) assert.equal(remoteReceipt(detail, record, id), null)
})

test('wrong run, wrong input, error payload and empty successful envelope fail closed', () => {
  const foreign = fixture(); foreign.thread.id = '00000000-0000-4000-8000-000000000003'
  const wrongRepo = fixture(); wrongRepo.chunks[1].chunk.input.repoName = 'foreign/private'
  const error = fixture(); error.chunks[2].chunk.output = { isError: true, content: [{ type: 'text', text: 'error'.repeat(30) }] }
  const empty = fixture(); empty.chunks[2].chunk.output = []
  const refused = fixture(); refused.chunks[4].chunk.output = { error: 'refused' }
  for (const detail of [foreign, wrongRepo, error, empty, refused]) assert.throws(() => remoteReceipt(detail, record, id), /^Error: native_mcp_/)
})

test('Task receipts require the identical call ID and exactly one selected native MCP call', () => {
  const mismatched = fixture(); mismatched.chunks[2].chunk.toolCallId = 'run_structure'
  assert.equal(remoteReceipt(mismatched, record, id), null)
  const duplicate = fixture()
  duplicate.chunks.splice(3, 0,
    wrap({ type: 'tool-input-available', toolName: prefix + 'read_wiki_structure', toolCallId: 'second', input: { repoName: 'vercel/ai' } }),
    wrap({ type: 'tool-output-available', toolCallId: 'second', output: 'A separate native result '.repeat(8) }))
  assert.throws(() => remoteReceipt(duplicate, record, id), /tool_receipt_invalid/)
})

test('one requested harness means one case with unchanged exact app and worker pins', () => {
  const args = ['--expected-build', 'a'.repeat(40), '--expected-worker-sha', 'b'.repeat(40),
    '--expected-worker-source', 'a'.repeat(40), '--output', '/tmp/native-report.json']
  assert.deepEqual(options(args).harnesses, ['codex'])
  assert.equal(options(args).actor, 'authorized_2023_codex')
  assert.deepEqual(options([...args, '--harness', 'codex']).harnesses, ['codex'])
  assert.throws(() => options([...args, '--harness', 'deepseek-flash']), /options_invalid/)
  assert.throws(() => options([...args, '--baseline-report', '/tmp/obsolete.json']), /options_invalid/)
  const prepare = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/acceptance/cloud-native-mcp.mjs', ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HTTPS_PROXY: 'http://127.0.0.1:1' } })
  assert.equal(prepare.status, 0)
  assert.equal(JSON.parse(prepare.stdout).status, 'prepared_no_network')
  assert.doesNotMatch(prepare.stdout + prepare.stderr, /password|Bearer|PRIVATE/)
})

test('a different model/provider cannot be selected for the owned Codex case', () => {
  const args = ['--expected-build', 'a'.repeat(40), '--expected-worker-sha', 'b'.repeat(40), '--expected-worker-source', 'a'.repeat(40), '--output', '/tmp/native-report.json']
  for (const harness of ['both', 'claude_code', 'deepseek-flash']) assert.throws(() => options([...args, '--harness', harness]), /options_invalid/)
})

const ownedEnv = { MIKKA_TEST_ACCOUNT_EMAIL: 'alexjiang20232024@gmail.com', MIKKA_TEST_ACCOUNT_PASSWORD: 'PRIVATE_PASSWORD' }
const actorConfig = () => options(['--expected-build', 'a'.repeat(40), '--expected-worker-sha', 'b'.repeat(40),
  '--expected-worker-source', 'c'.repeat(40), '--output', '/tmp/unused-owned-mcp-report.json'])

function ownedFixture({ collision = false, mismatch = false, failedCase = false, foreignPayer = false, paidFallback = false } = {}) {
  const owner = 'fixture-authorized-owner', workspace = '00000000-0000-4000-8000-000000000009'
  const accountHash = createHash('sha256').update(owner).digest('hex').slice(0, 16)
  const workspaceHash = createHash('sha256').update('personal-workspace\0' + workspace).digest('hex')
  const config = actorConfig(), journal = [], calls = [], created = [], removed = []
  const existing = { id: '00000000-0000-4000-8000-000000000008', name: 'Existing private connection' }
  let server, startups = 0
  const fetchImpl = async (url, init) => {
    const path = url.pathname.replace('/mikka', ''); calls.push(path)
    if (path === '/api/version') return Response.json({ build: config.build })
    if (path === '/api/auth/sign-in/email') {
      assert.deepEqual(JSON.parse(init.body), { email: ownedEnv.MIKKA_TEST_ACCOUNT_EMAIL, password: ownedEnv.MIKKA_TEST_ACCOUNT_PASSWORD, rememberMe: false })
      return Response.json({}, { headers: { 'set-cookie': 'session=PRIVATE_COOKIE; HttpOnly' } })
    }
    assert.ok(init.headers.cookie.includes('session=PRIVATE_COOKIE'))
    if (path === '/api/auth/get-session') return Response.json({ user: { id: owner, email: ownedEnv.MIKKA_TEST_ACCOUNT_EMAIL } })
    if (path === '/api/workspace') return Response.json({ currentUserId: owner, workspace: { id: workspace, kind: 'personal' }, role: 'admin',
      choices: [{ id: workspace, kind: 'personal' }], members: [{ userId: owner, role: 'admin', status: 'active' }] })
    if (path === '/api/rpc') {
      const body = JSON.parse(init.body); assert.equal(body.action, 'workspace.switchWorkspace'); assert.deepEqual(body.args, [workspace])
      return Response.json({ version: 1, ok: true, result: { workspaceId: workspace } })
    }
    if (path === '/api/auth/sign-out') return Response.json({})
    if (path === '/api/settings/api-keys') return Response.json({ apiKeyAfterQuota: paidFallback, keys: [] })
    if (path === '/api/integrations/mcp') {
      if (init.method === 'POST') {
        const body = JSON.parse(init.body); created.push(body)
        assert.deepEqual({ ...body, name: undefined }, { name: undefined, url: 'https://mcp.deepwiki.com/mcp', transport: 'http', enabled: true })
        server = { ...body, id: collision ? existing.id : id, authKind: 'none', revision: 1, mine: true, shared: false }
        return Response.json({ server })
      }
      if (init.method === 'DELETE') { removed.push(JSON.parse(init.body).id); server = null; return Response.json({ deleted: true }) }
      return Response.json({ servers: [existing, ...(server && server.id !== existing.id ? [server] : [])] })
    }
    assert.fail('unexpected path: ' + path)
  }
  const startup = async (request, dependencies) => {
    startups++
    assert.equal(request.actor, 'authorized_2023_codex'); assert.equal(request.harness, 'codex'); assert.equal(request.runs, 1)
    assert.equal(request.expectedWorkerSha, config.workerSha); assert.equal(request.expectedWorkerSource, config.workerSourceCommit)
    assert.equal(request.expectedBuild, config.build); assert.equal(request.strategy, 'derived')
    assert.equal(dependencies.env.MIKKA_TEST_ACCOUNT_EMAIL, ownedEnv.MIKKA_TEST_ACCOUNT_EMAIL)
    await dependencies.onFixture({ kind: 'run', id: runId })
    const proof = { status: 'passed', serverId: id, revision: 1,
      worker: { runId, workerSha: config.workerSha, workerSourceCommit: config.workerSourceCommit },
      remote: { serverId: id, calls: [{}], handoff: { successful: true }, terminal: 'succeeded' } }
    return { actor: 'authorized_2023_codex', build: config.build, revision: config.build, workspace: { kind: 'personal', workspaceHash }, cleanup: { errors: [], workspaceRestored: true },
      samples: [{ runId, issueId: runId, sampleId: 'case_codex', harness: 'codex', status: failedCase ? 'failed' : 'execution_proved_awaiting_server_timing',
        ...(failedCase ? { failure: { code: 'startup_ended_before_execution_proof' } } : {}), nativeMcp: proof,
        execution: { model: 'gpt-6-luna', credentialType: 'subscription', ownedScope: { verified: true, access: 'owner', requesterHash: accountHash, workspaceHash,
          payerHash: foreignPayer ? 'f'.repeat(16) : accountHash } }, cleanup: { status: 'passed', taskDeleted: true } }] }
  }
  return { config, calls, journal, created, removed, startups: () => startups, dependencies: { fetchImpl, startup,
    journal: async row => journal.push(row), readWorkerRelease: async () => ({ workerSha: mismatch ? 'f'.repeat(40) : config.workerSha, sourceCommit: config.workerSourceCommit }) } }
}

test('one owned Codex task keeps its exact source, private fixture journal and normal connection/session cleanup', async () => {
  const f = ownedFixture(), report = await run(f.config, ownedEnv, f.dependencies)
  assert.equal(report.status, 'passed', JSON.stringify(report)); assert.equal(f.startups(), 1)
  assert.equal(report.actor, 'authorized_2023_codex'); assert.equal(report.samples[0].execution.sharedScope, undefined)
  assert.equal(f.created.length, 1); assert.deepEqual(f.removed, [id])
  assert.equal(f.journal[0].actor, report.actor); assert.equal(f.journal[0].caseId, report.caseId)
  assert.ok(f.journal.some(row => row.kind === 'mcp_connection' && row.id === id))
  assert.ok(f.journal.some(row => row.kind === 'run' && row.id === runId))
  assert.equal(f.journal.at(-1).status, 'passed')
  assert.equal(report.cleanup.workspaceRestored, true); assert.equal(report.cleanup.sessionClosed, true)
  assert.doesNotMatch(JSON.stringify([report, f.journal]), /PRIVATE|alexjiang|PASSWORD|workspace_share/)
})

test('worker mismatch, foreign payer and actual failed execution never retry or become a pass', async () => {
  for (const change of [{ mismatch: true }, { paidFallback: true }, { foreignPayer: true }, { failedCase: true }]) {
    const f = ownedFixture(change), report = await run(f.config, ownedEnv, f.dependencies)
    assert.equal(report.status, 'failed'); assert.equal(f.startups(), change.mismatch || change.paidFallback ? 0 : 1)
    if (change.mismatch) { assert.equal(f.created.length, 0); assert.equal(report.failure, 'worker_mismatch') }
    else if (change.paidFallback) { assert.equal(f.created.length, 0); assert.equal(report.failure, 'paid_fallback_enabled'); assert.equal(report.cleanup.sessionClosed, true) }
    else { assert.deepEqual(f.removed, [id]); assert.equal(report.cleanup.sessionClosed, true) }
  }
})

test('an existing MCP connection can never become this case fixture or be deleted by its cleanup', async () => {
  const f = ownedFixture({ collision: true }), report = await run(f.config, ownedEnv, f.dependencies)
  assert.equal(report.status, 'failed'); assert.equal(report.failure, 'connection_invalid')
  assert.equal(f.startups(), 0); assert.deepEqual(f.removed, [])
  assert.equal(report.cleanup.sessionClosed, true)
})
