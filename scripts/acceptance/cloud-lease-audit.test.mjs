import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { leaseAuditInstructions, leaseAuditReceipt, naturalRenewalEvidence, readDaemonRenewal, runLeaseAudit } from './cloud-lease-audit.mjs'

const runId = '10000000-0000-4000-8000-000000000001'
const valid = { runId, harness: 'codex', status: 'renewed', valid: true, renewValid: true,
  httpStatus: 200, renewHttpStatus: 200, expiresAt: 2000000000, renewExpiresAt: 2000003600,
  naturalWindowObserved: true }
const chunks = value => [{ chunk: { type: 'tool-output-available', output: { stdout: 'MIKKA_LEASE_AUDIT=' + JSON.stringify(value) + '\n' } } }]
test('real CLI survives startup re-importing its lease helpers and writes the pending report', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-lease-cli-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const entry = join(directory, 'cloud-lease-audit.mjs')
  await writeFile(entry, await readFile(new URL('./cloud-lease-audit.mjs', import.meta.url)))
  // Isolate network/setup, retaining the actual CLI -> startup -> CLI ESM cycle.
  // The separate existing tests exercise the real production target guards.
  await writeFile(join(directory, 'auth-audit-production.mjs'), "export const auditTarget = () => 'a'.repeat(40)\n")
  const samples = ['claude_code', 'codex'].map(harness => ({
    runId, harness, requestedModel: harness === 'codex' ? 'gpt-6-luna' : 'claude-haiku-5-5',
    status: 'execution_proved_awaiting_server_timing', cleanup: { status: 'passed' },
    leaseAudit: { ...valid, harness }, requireReplyAfterTool: true, replyVerifiedAfterTool: true, lastStatus: 'completed',
  }))
  const fixture = { status: 'candidate_subscription_proved', cleanup: { errors: [] }, samples }
  await writeFile(join(directory, 'cloud-startup.mjs'),
    "export async function runCloudStartup() { const helpers = await import('./cloud-lease-audit.mjs'); " +
    "if (typeof helpers.leaseAuditReceipt !== 'function') throw Error('helpers_missing'); return " + JSON.stringify(fixture) + '; }\n')
  const result = spawnSync(process.execPath, [entry], { cwd: directory, encoding: 'utf8', timeout: 5000,
    env: { PATH: process.env.PATH, DAEMON_RENEWAL_EVIDENCE: 'posthog_plugin' } })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(await readFile(join(directory, 'production-lease-audit-report/report.json'), 'utf8'))
  assert.equal(report.status, 'awaiting_posthog_plugin')
  assert.equal(report.samples.length, 2)
  assert.ok(report.samples.every(sample => sample.naturalRenewalVerified === false))
})
test('ordinary cloud audit uses real daemon spans without claiming a trusted candidate host', async () => {
  const applicationSha = 'a'.repeat(40)
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: applicationSha, APPLICATION_SHA: applicationSha }
  const observed = []
  const report = await runLeaseAudit(env, {
    runStartup: async (options, dependencies) => {
      assert.equal(dependencies.env, env)
      assert.equal(options.mode, 'candidate'); assert.equal(options.harness, 'both'); assert.equal(options.runs, 2)
      assert.equal(options.officialTiming, 'disabled'); assert.equal(options.runtimeEvidence, 'optional')
      assert.equal(options.leaseAudit, true); assert.equal(options.expectedBuild, applicationSha)
      return { status: 'candidate_subscription_proved', cleanup: { errors: [] }, samples: ['claude_code', 'codex'].map(harness => ({
        runId, harness, requestedModel: harness === 'codex' ? 'gpt-6-luna' : 'claude-haiku-5-5',
        status: 'execution_proved_awaiting_server_timing', cleanup: { status: 'passed' },
        leaseAudit: leaseAuditReceipt(chunks({ ...valid, harness }), runId, harness),
        requireReplyAfterTool: true, replyVerifiedAfterTool: true, lastStatus: 'completed',
      })) }
    },
    readRenewal: async sample => {
      observed.push(sample.harness)
      return { source: 'posthog_daemon_refresh_span', runIdHash: createHash('sha256').update(runId).digest('hex').slice(0, 16),
        harness: sample.harness, started: 1, completed: 1, errors: 0 }
    },
  })
  assert.equal(report.status, 'passed'); assert.deepEqual(observed, ['claude_code', 'codex'])
  assert.ok(report.samples.every(sample => sample.naturalRenewalVerified))
})

test('daemon evidence queries only the owned run hash and expiry interval and rejects missing or failed spans', async () => {
  const env = { POSTHOG_PERSONAL_API_KEY: 'phx_PRIVATE_QUERY_TOKEN' }
  const sample = { runId, harness: 'codex', leaseAudit: leaseAuditReceipt(chunks(valid), runId, 'codex'),
    requireReplyAfterTool: true, replyVerifiedAfterTool: true, lastStatus: 'completed' }
  const fetchImpl = async (url, init) => {
    assert.equal(url, 'https://us.posthog.com/api/projects/670821/query/')
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error')
    const body = JSON.parse(init.body)
    assert.match(body.query.query, /service_name = 'mikka-daemon'/)
    assert.match(body.query.query, /name = 'daemon.adapter.auth.refresh'/)
    assert.match(body.query.query, /toDateTime\(1999999940\)/)
    assert.match(body.query.query, /toDateTime\(2000000030\)/)
    assert.doesNotMatch(init.body, /PRIVATE|10000000-0000/)
    return Response.json({ results: [[1, 1, 0]], private: 'PRIVATE_RESPONSE' })
  }
  const daemonRenewal = await readDaemonRenewal(sample, { env, fetchImpl })
  assert.doesNotMatch(JSON.stringify(daemonRenewal), /PRIVATE/)
  assert.equal(naturalRenewalEvidence({ ...sample, daemonRenewal }), true)
  for (const patch of [{ started: 0, completed: 0 }, { errors: 1 }, { runIdHash: 'f'.repeat(16) }, { harness: 'claude_code' }, { completed: 0 }])
    assert.equal(naturalRenewalEvidence({ ...sample, daemonRenewal: { ...daemonRenewal, ...patch } }), false)
  assert.equal(naturalRenewalEvidence({ ...sample, daemonRenewal, replyVerifiedAfterTool: false }), false)
  assert.equal(naturalRenewalEvidence({ ...sample, daemonRenewal, lastStatus: 'failed' }), false)
  assert.equal(await readDaemonRenewal({ ...sample, leaseAudit: { status: 'outside_natural_window' } }, { env, fetchImpl: () => assert.fail('no unrelated trace read') }), undefined)
  await assert.rejects(readDaemonRenewal(sample, { env, fetchImpl: async () => new Response('PRIVATE_BODY', { status: 403 }) }), /lease_audit_trace_http_403/)
  for (const results of [[[1, 0, 0]], [['1', 1, 0]], [[1, 1, 0], [1, 1, 0]]])
    await assert.rejects(readDaemonRenewal(sample, { env, fetchImpl: async () => Response.json({ results }) }), /lease_audit_trace_invalid/)
})

test('plugin collection keeps natural renewal unverified until matching external spans arrive', async () => {
  const applicationSha = 'a'.repeat(40)
  const env = { GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_SHA: applicationSha, APPLICATION_SHA: applicationSha, DAEMON_RENEWAL_EVIDENCE: 'posthog_plugin' }
  for (const status of ['renewed', 'outside_natural_window', 'renewal_failed']) {
    const report = await runLeaseAudit(env, {
      readRenewal: () => assert.fail('plugin mode must not request a local or runner PostHog key'),
      runStartup: async () => ({ status: 'candidate_subscription_proved', cleanup: { errors: [] }, samples: ['claude_code', 'codex'].map(harness => ({
        runId, harness, requestedModel: harness === 'codex' ? 'gpt-6-luna' : 'claude-haiku-5-5',
        status: 'execution_proved_awaiting_server_timing', cleanup: { status: 'passed' },
        leaseAudit: { ...valid, status }, requireReplyAfterTool: true, replyVerifiedAfterTool: true, lastStatus: 'completed',
        runtimeTiming: { complete: true, truncated: false, counts: [{ endpoint: 'credential_refresh', started: 1, completed: 1, errors: 0 }] },
      })) }),
    })
    assert.equal(report.status, status === 'renewed' ? 'awaiting_posthog_plugin' : 'blocked')
    assert.equal(report.requiredExternalEvidence.projectId, 670821)
    for (const sample of report.samples) {
      assert.equal(sample.naturalRenewalVerified, false)
      const input = { ...sample, leaseAudit: sample.lease }
      assert.equal(naturalRenewalEvidence(input), false)
      const daemonRenewal = { source: 'posthog_daemon_refresh_span', runIdHash: createHash('sha256').update(runId).digest('hex').slice(0, 16),
        harness: sample.harness, started: 1, completed: 1, errors: 0 }
      assert.equal(naturalRenewalEvidence({ ...input, daemonRenewal }), status === 'renewed')
      assert.equal(naturalRenewalEvidence({ ...input, daemonRenewal: { ...daemonRenewal, errors: 1 } }), false)
      assert.equal(naturalRenewalEvidence({ ...input, daemonRenewal, replyVerifiedAfterTool: false }), false)
    }
  }
})
test('lease receipt accepts only the exact owned run and closed tool output fields', () => {
  const receipt = leaseAuditReceipt(chunks({ ...valid, accessToken: 'PRIVATE_TOKEN', credential: 'PRIVATE_DEVICE' }), runId, 'codex')
  assert.equal(receipt.status, 'renewed')
  assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE|accessToken|credential/)
  for (const value of [{ ...valid, runId: 'foreign' }, { ...valid, harness: 'claude_code' }, { ...valid, status: 'invented' }]) {
    assert.equal(leaseAuditReceipt(chunks(value), runId, 'codex').status, 'receipt_missing')
  }
  assert.equal(leaseAuditReceipt([{ chunk: { type: 'text-delta', delta: 'MIKKA_LEASE_AUDIT=' + JSON.stringify(valid) } }], runId, 'codex').status, 'receipt_missing')
})
test('live issuance and model claims cannot stand in for natural daemon renewal', () => {
  const sample = { leaseAudit: leaseAuditReceipt(chunks(valid), runId, 'codex'), runtimeTiming: { complete: true, truncated: false,
    counts: [{ endpoint: 'credential_refresh', started: 1, completed: 1, errors: 0 }] } }
  assert.equal(naturalRenewalEvidence(sample), true)
  for (const patch of [{ counts: [] }, { complete: false }, { truncated: true },
    { counts: [{ endpoint: 'credential_lease', started: 2, completed: 2, errors: 0 }] },
    { counts: [{ endpoint: 'credential_refresh', started: 1, completed: 1, errors: 1 }] }]) {
    assert.equal(naturalRenewalEvidence({ ...sample, runtimeTiming: { ...sample.runtimeTiming, ...patch } }), false)
  }
  assert.equal(naturalRenewalEvidence({ ...sample, leaseAudit: { ...sample.leaseAudit, status: 'outside_natural_window' } }), false)
})
test('task instruction rejects injected markers and binds the original small model harness', async () => {
  await assert.rejects(() => leaseAuditInstructions("x'); print('leak')", 'codex'))
  await assert.rejects(() => leaseAuditInstructions('sample', 'unknown'))
  const prompt = await leaseAuditInstructions('sample', 'codex')
  assert.ok(prompt.includes('STARTUP_OK_sample'))
  assert.ok(prompt.includes('gpt-6-luna'))
  assert.ok(prompt.includes('NoRedirect'))
})
test('VM probe scopes its journal and never prints credential or lease bodies', () => {
  const driver = String.raw`
import importlib.util, pathlib, json, io, contextlib
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('probe','scripts/acceptance/cloud-lease-probe.py')
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
assignment={'runId':'${runId}','deviceId':'own-device','harness':'codex','prompt':'STARTUP_OK_sample'}
device={'deviceId':'own-device','credential':'PRIVATE_DEVICE'}
def read(path):
    return json.dumps(device if path.name=='device.json' else {'runs':{'one':{'state':'running','assignment':assignment}}})
class Response:
    status=200
    def __enter__(self): return self
    def __exit__(self,*args): pass
    def read(self): return json.dumps({'expiresAt':'2099-01-01T00:00:00Z','modelId':'gpt-6-luna','route':'codex_cli','accountId':'PRIVATE_ACCOUNT','revision':1,'accessToken':'PRIVATE_PROVIDER'}).encode()
class Client:
    def open(self, request, timeout):
        assert request.full_url.endswith('/v1/devices/own-device/runs/${runId}/subscription-lease')
        assert request.method=='POST' and request.headers['Authorization']=='Bearer PRIVATE_DEVICE'
        return Response()
with patch.object(pathlib.Path,'read_text',read), patch.object(module.urllib.request,'build_opener',lambda *args:Client()), patch.object(module.time,'sleep',lambda _: (_ for _ in ()).throw(AssertionError('must not wait hours'))):
    out=io.StringIO()
    with contextlib.redirect_stdout(out): module.main('STARTUP_OK_sample','codex')
    result=out.getvalue()
    assert 'PRIVATE' not in result
    assert json.loads(result.split('=',1)[1])['status']=='outside_natural_window'
    assignment['deviceId']='foreign-device'
    assert module.probe('STARTUP_OK_sample','codex')['status']=='scope_refused'
print('probe guards passed')
`
  const result = spawnSync('python3', ['-B', '-c', driver], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'probe guards passed')
})
