import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { cleanupOwnedProbe, probeMarkedIngress } from './preview-ingress-acceptance.mjs'

const SOURCE = 'a'.repeat(40)
const MARKER = 'mikka-synthetic-socket-mark-probe-v1'
const PROBE_PATH = fileURLToPath(new URL('./preview-ingress-probe.py', import.meta.url))

function fixture({ unavailable = false, reusedPortExposed = false, ruleUnavailable = false,
  outboundFailed = false, providerFailed = false, ipv6PositiveFailed = false } = {}) {
  const calls = []
  let stage = 'before', send, finished = false, resolveCompletion
  const completion = new Promise(accept => { resolveCompletion = accept })
  const sandbox = {
    sandboxId: 'sandbox-fixture', getInfo: async () => ({ templateId: 'template-fixture' }),
    getHost: port => `${port}.example.test`, files: { write: async () => {} },
    commands: { run: async (command, options) => {
      if (!options.background) {
        if (command === "printf 'mikka-synthetic-provider-control-v1'") {
          assert.equal(options.user, 'user')
          return { stdout: providerFailed ? '' : 'mikka-synthetic-provider-control-v1' }
        }
        return { stdout: '' }
      }
      assert.equal(options.user, 'root')
      assert.equal(options.stdin, true)
      send = value => options.onStdout(JSON.stringify(value) + '\n')
      const diagnostic = { capabilities: { netAdmin: !unavailable, netRaw: !unavailable }, tools: Object.fromEntries(
        ['iptables', 'ip6tables', 'nft'].map(name => [name, { present: !unavailable, source: 'private',
          version: unavailable ? null : '1.8.11', backend: 'nf_tables', privateText: 'must-never-leave-fixture' }])),
      kernel: { release: '6.1.158', configSource: 'proc', options: { CONFIG_MODULES: 'n',
        CONFIG_NETFILTER_XT_MATCH_SOCKET: 'n', CONFIG_NF_SOCKET_IPV4: 'n', CONFIG_NF_SOCKET_IPV6: 'n',
        CONFIG_NF_TABLES: 'y', CONFIG_NFT_META: 'y', CONFIG_NFT_CT: 'y', PRIVATE_OPTION: 'must-never-leave-fixture' } } }
      if (unavailable) {
        send({ phase: 'failed', code: 'socket_mark_unavailable', privateText: 'must-never-leave-fixture', ...diagnostic })
        send({ phase: 'finished', rulesRemoved: true })
        finished = true; resolveCompletion()
      } else send({ phase: 'ready', ...diagnostic, ports: { rootMarked: 41001, userLoopback4: 41002, userPublic4: 41003, userLoopback6: 41004 },
        user: { canSetSocketMark: false, sudoNonInteractiveRoot: true, noNewPrivileges: false },
        providerListeners: { 49983: { listening: true, allRoot: true }, 50005: { listening: true, allRoot: true } },
        privateText: 'must-never-leave-fixture' })
      return {
        wait: () => completion,
        sendStdin: async data => {
          if (finished) throw new Error('Synthetic closed process')
          calls.push(data)
          if (data === 'protect\n') {
            if (ruleUnavailable) send({ phase: 'failed', code: 'reply_rule_unavailable_ipv4', ...diagnostic,
              ruleFailure: { exitCode: 2, unsupportedRevision: true, missingKernelModule: true, missingExtension: true,
                stderr: 'must-never-leave-fixture', command: 'must-never-leave-fixture' } })
            else { stage = 'after'; send({ phase: 'protected', rules: { ipv4: true, ipv6: true },
              providerListeners: { 49983: { listening: true, allRoot: true }, 50005: { listening: true, allRoot: true } } }) }
          }
          else if (data === 'outbound https://41001.example.test/\n') send({ phase: 'outbound',
            status: outboundFailed ? null : 200, markerMatched: !outboundFailed })
          else if (data === 'replace\n') { stage = 'replacement'; send({ phase: 'replaced', port: 41001 }) }
          else if (data === 'finish\n') { send({ phase: 'finished', rulesRemoved: true }); finished = true; resolveCompletion() }
          else assert.fail('Unknown stdin operation')
        },
      }
    } },
  }
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'manual')
    assert.equal(options.headers.connection, 'close')
    const permitted = (stage === 'before' || stage === 'after' && new URL(url).hostname.startsWith('41001.')
      || stage === 'replacement' && reusedPortExposed)
      && !(ipv6PositiveFailed && new URL(url).hostname.startsWith('41004.'))
    return new Response(permitted ? MARKER : 'Denied', { status: permitted ? 200 : 403 })
  }
  return { sandbox, fetchImpl, calls }
}

test('missing root/kernel capabilities preserve closed diagnostics and never start public samples', async () => {
  const value = fixture({ unavailable: true })
  await assert.rejects(probeMarkedIngress(value.sandbox, SOURCE, async () => assert.fail('No network sample')), error => {
    assert.equal(error.message, 'socket_mark_unavailable')
    assert.deepEqual(error.evidence.capabilities, { netAdmin: false, netRaw: false })
    assert.equal(error.evidence.tools.ip6tables.present, false)
    assert.equal(error.evidence.passed, false)
    assert.ok(!JSON.stringify(error.evidence).includes('must-never-leave-fixture'))
    return true
  })
})

test('source scope is checked before SDK commands or fixture creation', async () => {
  await assert.rejects(probeMarkedIngress({}, 'not-an-immutable-source'), /source_invalid/)
})

test('a rejected reply rule preserves the actual kernel/backend and only closed failure observations', async () => {
  const value = fixture({ ruleUnavailable: true })
  await assert.rejects(probeMarkedIngress(value.sandbox, SOURCE, value.fetchImpl), error => {
    const report = error.evidence
    assert.equal(error.message, 'reply_rule_unavailable_ipv4')
    assert.equal(report.before.userLoopback4.markerMatched, true)
    assert.deepEqual(report.after, {})
    assert.equal(report.capabilities.netAdmin, true)
    assert.equal(report.tools.iptables.backend, 'nf_tables')
    assert.equal(report.kernel.release, '6.1.158')
    assert.equal(report.kernel.options.CONFIG_NETFILTER_XT_MATCH_SOCKET, 'n')
    assert.equal(report.kernel.options.CONFIG_NFT_CT, 'y')
    assert.deepEqual(report.ruleFailure, { exitCode: 2, unsupportedRevision: true, missingKernelModule: true,
      missingExtension: true, operationNotSupported: false, permissionDenied: false, invalidArgument: false })
    assert.equal(report.passed, false)
    assert.ok(!JSON.stringify(report).includes('must-never-leave-fixture'))
    return true
  })
})

test('Python diagnostics classify fixed kernel errors without exporting raw command output', () => {
  const program = String.raw`
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('probe',sys.argv[1])
probe=importlib.util.module_from_spec(spec);spec.loader.exec_module(probe)
cases=[probe.rule_failure(2,b"Warning: Extension socket revision 3 not supported, missing kernel module?\niptables: Couldn't load match socket. PRIVATE_DETAIL"),
       probe.rule_failure(1,b'Operation not supported. PRIVATE_DETAIL'),
       probe.rule_failure(1,b'Permission denied. PRIVATE_DETAIL'),
       probe.rule_failure(-9,b'PRIVATE_DETAIL')]
print(json.dumps(cases))
`
  const output = execFileSync('python3', ['-c', program, PROBE_PATH], { encoding: 'utf8' })
  assert.ok(!output.includes('PRIVATE_DETAIL'))
  const [missing, unsupported, forbidden, unknown] = JSON.parse(output)
  assert.equal(missing.unsupportedRevision, true)
  assert.equal(missing.missingKernelModule, true)
  assert.equal(missing.missingExtension, true)
  assert.equal(unsupported.operationNotSupported, true)
  assert.equal(forbidden.permissionDenied, true)
  assert.equal(unknown.exitCode, null)
})

test('the Python policy confines rules to owned OUTPUT source ports and refuses legacy/provider scope', () => {
  const program = String.raw`
import importlib.util,json,sys,types
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('probe',sys.argv[1])
probe=importlib.util.module_from_spec(spec);spec.loader.exec_module(probe)
for ports in ([49983],[50005],[True],[0],[],list(range(41000,41016))):
 try: probe.Policy(ports)
 except probe.Refused as e: assert str(e)=='ports_invalid'
 else: raise AssertionError('Unsafe fixture scope accepted')
calls=[]
def run(args,**kwargs):
 calls.append(args)
 return types.SimpleNamespace(returncode=0,stdout=b'iptables v1.8.10 (nf_tables)',stderr=b'')
with patch.object(probe.shutil,'which',side_effect=lambda name,**kwargs:'/usr/sbin/'+name),patch.object(probe.subprocess,'run',side_effect=run):
 policy=probe.Policy([41001,41002,41003,41004]);assert policy.install()=={'ipv4':True,'ipv6':True};assert policy.close()
assert not any('INPUT' in args or '--dports' in args or 'socket' in args for args in calls)
for args in calls:
 if '--insert' in args:
  assert 'OUTPUT' in args and args[args.index('--sports')+1]=='41001,41002,41003,41004'
  assert args[args.index('-o')-1]=='!' and args[args.index('-o')+1]=='lo'
 if '--append' in args:
  assert args[args.index('--ctdir')+1]=='REPLY' and args[args.index('--mark')-1]=='!'
with patch.object(probe.shutil,'which',return_value='/usr/sbin/iptables'),patch.object(probe.subprocess,'run',return_value=types.SimpleNamespace(returncode=0,stdout=b'iptables v1.8.10 (legacy)',stderr=b'')) as mocked:
 try: probe.Policy([41001]).install()
 except probe.Refused as e: assert str(e)=='nft_backend_unavailable_ipv4'
 else: raise AssertionError('Legacy backend silently accepted')
 assert mocked.call_count==1
print(json.dumps({'scopeChecked':True,'families':2,'kernelExecuted':False}))
`
  const output = JSON.parse(execFileSync('python3', ['-c', program, PROBE_PATH], { encoding: 'utf8' }))
  assert.deepEqual(output, { scopeChecked: true, families: 2, kernelExecuted: false })
})

test('reply mark proof requires positive controls, raw port refusal, outbound, provider, replacement refusal and cleanup', async () => {
  const value = fixture()
  const report = await probeMarkedIngress(value.sandbox, SOURCE, value.fetchImpl)
  assert.equal(report.passed, true)
  assert.equal(report.policy, 'nft_output_reply_mark')
  assert.equal(report.policyScope, 'owned_fixture_ports_only')
  assert.equal(report.preListenerIsolationProven, false)
  assert.equal(report.agentPrivilegeBoundaryProven, false)
  assert.equal(report.user.sudoNonInteractiveRoot, true, 'an available sudo boundary is disclosed, never hidden')
  assert.equal(report.user.noNewPrivileges, false)
  assert.deepEqual(value.calls, ['protect\n', 'outbound https://41001.example.test/\n', 'replace\n', 'finish\n'])
  assert.equal(report.before.userLoopback4.markerMatched, true)
  assert.equal(report.after.userLoopback4.markerMatched, false)
  assert.equal(report.after.rootMarked.markerMatched, true)
  assert.equal(report.before.userLoopback6.markerMatched, true)
  assert.equal(report.after.userLoopback6.markerMatched, false)
  assert.equal(report.outbound.markerMatched, true)
  assert.equal(report.providerControlRoundTrip, true)
  assert.equal(report.replacement.markerMatched, false)
  assert.equal(report.rulesRemoved, true)
  assert.ok(!JSON.stringify(report).includes('must-never-leave-fixture'))
})

test('a blocked ordinary user outbound request fails the capability verdict', async () => {
  const value = fixture({ outboundFailed: true })
  const report = await probeMarkedIngress(value.sandbox, SOURCE, value.fetchImpl)
  assert.equal(report.passed, false)
  assert.equal(report.outbound.markerMatched, false)
  assert.equal(report.rulesRemoved, true)
})

test('an unavailable provider command fails before more external sampling', async () => {
  const value = fixture({ providerFailed: true })
  await assert.rejects(probeMarkedIngress(value.sandbox, SOURCE, value.fetchImpl), error => {
    assert.equal(error.message, 'provider_control_failed')
    assert.equal(error.evidence.providerControlRoundTrip, false)
    assert.deepEqual(error.evidence.after, {})
    assert.equal(error.evidence.rulesRemoved, true)
    return true
  })
})

test('a missing IPv6 loopback positive control cannot count as successful isolation', async () => {
  const value = fixture({ ipv6PositiveFailed: true })
  await assert.rejects(probeMarkedIngress(value.sandbox, SOURCE, value.fetchImpl), /positive_control_failed/)
  assert.deepEqual(value.calls, ['finish\n'])
})

test('a user listener inheriting the old root port is a failed proof even when every other check passes', async () => {
  const value = fixture({ reusedPortExposed: true })
  const report = await probeMarkedIngress(value.sandbox, SOURCE, value.fetchImpl)
  assert.equal(report.passed, false)
  assert.equal(report.replacement.markerMatched, true)
  assert.equal(report.rulesRemoved, true)
})

const journal = () => ({ version: 1, purpose: 'mikka-preview-ingress-spike', sourceCommit: SOURCE,
  fixtureId: '99999999-0000-4000-8000-000000000001', requestedTemplate: 'claude', sandboxId: 'owned-sandbox' })
const metadata = value => ({ application: value.purpose, issue: '1724', sourceCommit: value.sourceCommit,
  fixtureId: value.fixtureId, requestedTemplate: value.requestedTemplate })

test('cleanup checks the recorded source, unique fixture, template and exact VM before deletion', async () => {
  const value = journal(), deleted = []
  let info = { sandboxId: value.sandboxId, metadata: metadata(value) }
  const sdk = { Sandbox: { getInfo: async () => info, kill: async id => { deleted.push(id); return true } } }
  await assert.rejects(cleanupOwnedProbe(value, 'b'.repeat(40), sdk), /cleanup_scope/)
  for (const changed of [{ sandboxId: 'foreign' }, { metadata: { ...info.metadata, fixtureId: 'foreign' } },
    { metadata: { ...info.metadata, sourceCommit: 'b'.repeat(40) } }, { metadata: { ...info.metadata, requestedTemplate: 'codex' } }]) {
    info = { sandboxId: value.sandboxId, metadata: metadata(value), ...changed }
    await assert.rejects(cleanupOwnedProbe(value, SOURCE, sdk), /cleanup_scope/)
  }
  assert.deepEqual(deleted, [])
  info = { sandboxId: value.sandboxId, metadata: metadata(value) }
  assert.deepEqual(await cleanupOwnedProbe(value, SOURCE, sdk),
    { stopped: true, outcome: 'provider_kill_acknowledged', scopeVerified: true })
  assert.deepEqual(deleted, [value.sandboxId])
})

test('a lost create reply reconciles only one exact metadata match and never sweeps ambiguous results', async () => {
  const value = { ...journal(), sandboxId: null }, deleted = []
  let found = [], more = false
  const sdk = { Sandbox: {
    list: options => {
      assert.deepEqual(options.query, { metadata: metadata(value) })
      assert.equal(options.limit, 2)
      return { nextItems: async () => found, get hasNext() { return more } }
    },
    getInfo: async id => ({ sandboxId: id, metadata: metadata(value) }),
    kill: async id => { deleted.push(id); return true },
  } }
  assert.deepEqual(await cleanupOwnedProbe(value, SOURCE, sdk),
    { stopped: false, outcome: 'creation_unconfirmed', scopeVerified: false })
  found = [{ sandboxId: 'first' }, { sandboxId: 'second' }]
  await assert.rejects(cleanupOwnedProbe(value, SOURCE, sdk), /cleanup_scope/)
  found = [{ sandboxId: 'only' }]; more = true
  await assert.rejects(cleanupOwnedProbe(value, SOURCE, sdk), /cleanup_scope/)
  assert.deepEqual(deleted, [])
  more = false
  assert.equal((await cleanupOwnedProbe(value, SOURCE, sdk)).stopped, true)
  assert.deepEqual(deleted, ['only'])
})

test('cleanup recognizes provider absence while transport failure never becomes a cleanup acknowledgment', async () => {
  class SandboxNotFoundError extends Error {}
  let failure = new SandboxNotFoundError('Synthetic absence')
  const sdk = { SandboxNotFoundError, Sandbox: {
    getInfo: async () => { throw failure }, kill: async () => assert.fail('An absent or unverified VM is never killed'),
  } }
  assert.deepEqual(await cleanupOwnedProbe(journal(), SOURCE, sdk),
    { stopped: true, outcome: 'provider_already_absent', scopeVerified: false })
  failure = new Error('Synthetic transport failure')
  await assert.rejects(cleanupOwnedProbe(journal(), SOURCE, sdk), error => {
    assert.equal(error.message, 'preview_ingress_cleanup_read_failed')
    assert.equal(error.cause, failure)
    return true
  })
})
