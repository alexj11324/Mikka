import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { leaseAuditInstructions, leaseAuditReceipt, naturalRenewalEvidence } from './cloud-lease-audit.mjs'

const runId = '10000000-0000-4000-8000-000000000001'
const valid = { runId, harness: 'codex', status: 'renewed', valid: true, renewValid: true,
  httpStatus: 200, renewHttpStatus: 200, expiresAt: 2000000000, renewExpiresAt: 2000003600,
  naturalWindowObserved: true }
const chunks = value => [{ chunk: { type: 'tool-output-available', output: { stdout: 'MIKKA_LEASE_AUDIT=' + JSON.stringify(value) + '\n' } } }]
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
