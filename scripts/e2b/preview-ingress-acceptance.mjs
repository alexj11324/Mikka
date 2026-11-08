#!/usr/bin/env node
/** Capability spike only: no production data, user task, Agent or model call.
 * This proves actual E2B ingress, SO_MARK, xt_socket and tool availability before
 * the production gateways or their original runtime contracts are changed. */
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const MARKER = 'mikka-synthetic-socket-mark-probe-v1'
const NAMES = ['userLoopback4', 'userPublic4', 'userLoopback6', 'rootMarked']
const REFUSALS = new Set(['root_required', 'socket_mark_unavailable', 'user_identity_invalid', 'user_fixture_start_timeout',
  'user_fixture_invalid', 'ports_invalid', 'operation_invalid', 'probe_internal_failure',
  'preview_ingress_process_ended', 'preview_ingress_phase_timeout', 'preview_ingress_phase_invalid',
  'preview_ingress_positive_control_failed',
  ...['ipv4', 'ipv6'].flatMap(family => ['tool_missing_', 'chain_unavailable_', 'socket_match_unavailable_',
    'reject_unavailable_', 'input_unavailable_', 'rule_unverified_'].map(prefix => prefix + family))])
const safeCode = error => REFUSALS.has(error?.message) ? error.message : 'preview_ingress_probe_failed'

async function sample(sandbox, port, fetchImpl) {
  try {
    const response = await fetchImpl(`https://${sandbox.getHost(port)}/`, { headers: { connection: 'close' },
      cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(12_000) })
    return { status: response.status, markerMatched: await response.text() === MARKER }
  } catch { return { status: null, markerMatched: false } }
}

export async function probeMarkedIngress(sandbox, sourceCommit, fetchImpl = fetch) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('preview_ingress_source_invalid')
  const source = await readFile(new URL('./preview-ingress-probe.py', import.meta.url), 'utf8')
  const report = { sourceCommit, sandboxId: sandbox.sandboxId, templateId: (await sandbox.getInfo()).templateId,
    probeSha256: createHash('sha256').update(source).digest('hex'), observedAt: new Date().toISOString(),
    before: {}, after: {}, replacement: null, passed: false, rulesRemoved: false }
  await sandbox.commands.run('install -d -m 755 /opt/mikka/ingress-probe', { user: 'root', timeoutMs: 10_000 })
  await sandbox.files.write('/opt/mikka/ingress-probe/probe.py', source, { user: 'root' })
  await sandbox.commands.run('chmod 755 /opt/mikka/ingress-probe/probe.py', { user: 'root', timeoutMs: 5_000 })
  const receipts = [], waiting = []
  let buffer = ''
  let ended = false
  const receive = () => receipts.length ? Promise.resolve(receipts.shift()) : ended ? Promise.reject(new Error('preview_ingress_process_ended'))
    : new Promise((accept, reject) => {
      const entry = { accept, reject }
      entry.timer = setTimeout(() => { waiting.splice(waiting.indexOf(entry), 1); reject(new Error('preview_ingress_phase_timeout')) }, 30_000)
      waiting.push(entry)
    })
  const deliver = receipt => {
    if (waiting.length) { const next = waiting.shift(); clearTimeout(next.timer); next.accept(receipt) }
    else receipts.push(receipt)
  }
  const process = await sandbox.commands.run('exec python3 /opt/mikka/ingress-probe/probe.py', {
    user: 'root', background: true, stdin: true, timeoutMs: 0, onStderr: () => {}, onStdout: text => {
      buffer += text
      if (buffer.length > 16_384 || receipts.length > 16) { deliver({ phase: 'failed', code: 'probe_internal_failure' }); return }
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
        try { deliver(JSON.parse(line)) } catch { deliver({ phase: 'failed', code: 'probe_internal_failure' }) }
      }
    },
  })
  const completion = process.wait().then(() => undefined, () => undefined).finally(() => {
    ended = true
    for (const entry of waiting.splice(0)) { clearTimeout(entry.timer); entry.reject(new Error('preview_ingress_process_ended')) }
  })
  const phase = async expected => {
    const value = await receive()
    if (value.capabilities) report.capabilities = { netAdmin: value.capabilities?.netAdmin === true, netRaw: value.capabilities?.netRaw === true }
    if (value.tools) report.tools = Object.fromEntries(['iptables', 'ip6tables'].map(name => [name, { present: value.tools?.[name]?.present === true,
      source: value.tools?.[name]?.source === 'private' ? 'private' : 'system',
      version: /^\d+\.\d+\.\d+$/.test(value.tools?.[name]?.version ?? '') ? value.tools[name].version : null }]))
    if (value.phase === 'failed') throw new Error(REFUSALS.has(value.code) ? value.code : 'probe_internal_failure')
    if (value.phase !== expected) throw new Error('preview_ingress_phase_invalid')
    return value
  }
  try {
    const ready = await phase('ready')
    const ports = ready.ports
    if (!ports?.rootMarked || !ports.userLoopback4 || !ports.userPublic4 || Object.keys(ports).some(name => !NAMES.includes(name))
      || Object.values(ports).some(port => !Number.isInteger(port) || port <= 1024 || port >= 65536)
      || new Set(Object.values(ports)).size !== Object.keys(ports).length) throw new Error('ports_invalid')
    report.user = { canSetSocketMark: ready.user?.canSetSocketMark === true,
      sudoNonInteractiveRoot: ready.user?.sudoNonInteractiveRoot === true }
    // Single bounded setup delay for envd's documented listener scan.
    await new Promise(accept => setTimeout(accept, 1500))
    for (const [name, port] of Object.entries(ports)) report.before[name] = await sample(sandbox, port, fetchImpl)
    if (!report.before.rootMarked.markerMatched || !report.before.userPublic4.markerMatched) throw new Error('preview_ingress_positive_control_failed')
    await process.sendStdin('protect\n')
    const protectedReply = await phase('protected')
    report.rules = { ipv4: protectedReply.rules?.ipv4 === true, ipv6: protectedReply.rules?.ipv6 === true }
    for (const [name, port] of Object.entries(ports)) report.after[name] = await sample(sandbox, port, fetchImpl)
    await process.sendStdin('replace\n')
    const replacement = await phase('replaced')
    if (replacement.port !== ports.rootMarked) throw new Error('ports_invalid')
    report.replacement = await sample(sandbox, ports.rootMarked, fetchImpl)
    await process.sendStdin('finish\n')
    const finished = await phase('finished')
    report.rulesRemoved = finished.rulesRemoved === true
    report.passed = report.capabilities.netAdmin && report.rules.ipv4 && report.rules.ipv6
      && report.after.rootMarked.markerMatched && !report.user.canSetSocketMark
      && NAMES.filter(name => name !== 'rootMarked' && ports[name]).every(name => !report.after[name].markerMatched)
      && !report.replacement.markerMatched && report.rulesRemoved
    return report
  } catch (error) {
    report.failure = safeCode(error)
    error.evidence = report
    throw error
  } finally {
    try { await process.sendStdin('finish\n') } catch { /* VM teardown below remains mandatory. */ }
    await Promise.race([completion, new Promise(accept => setTimeout(accept, 1000))])
  }
}

async function main(args) {
  const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
  const template = option('--template'), output = option('--output')
  if (!template || !/^[A-Za-z0-9_-]{1,128}$/.test(template) || !output || !process.env.E2B_API_KEY) throw new Error('preview_ingress_configuration')
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const { Sandbox } = await import('e2b')
  const sandbox = await Sandbox.create(template, { apiKey: process.env.E2B_API_KEY, proxy: process.env.HTTPS_PROXY ?? process.env.https_proxy,
    timeoutMs: 180_000, lifecycle: { onTimeout: 'kill', autoResume: false }, network: { allowPublicTraffic: true },
    metadata: { application: 'mikka-preview-ingress-spike', issue: '1724', sourceCommit, fixtureId: randomUUID() } })
  let report, failure
  try { report = await probeMarkedIngress(sandbox, sourceCommit) }
  catch (error) { failure = error; report = error.evidence ?? { sourceCommit, passed: false, failure: safeCode(error) } }
  finally {
    try { report.cleanup = { stopped: await sandbox.kill() !== false } }
    catch (cause) { report.cleanup = { stopped: false }; failure = new Error('preview_ingress_cleanup_failed', { cause }) }
  }
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  if (failure || !report.passed || !report.cleanup.stopped) throw new Error('preview_ingress_probe_failed', failure ? { cause: failure } : undefined)
  console.log(JSON.stringify({ sourceCommit, passed: true, evidence: resolve(output) }))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => { console.error('preview_ingress_probe_failed'); process.exitCode = 1 })
}
