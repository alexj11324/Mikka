#!/usr/bin/env node
/** Capability spike only: no production data, user task, Agent or model call.
 * This tests actual E2B ingress, SO_MARK replies and nft frontend availability before
 * the production gateways or their original runtime contracts are changed. */
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const MARKER = 'mikka-synthetic-socket-mark-probe-v1'
const PROVIDER_CONTROL = 'mikka-synthetic-provider-control-v1'
const PURPOSE = 'mikka-preview-ingress-spike'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const ID = /^[A-Za-z0-9_-]{1,128}$/
const SHA = /^[a-f0-9]{40}$/
const NAMES = ['userLoopback4', 'userPublic4', 'userLoopback6', 'rootMarked']
const KERNEL_OPTIONS = ['CONFIG_MODULES', 'CONFIG_NETFILTER_XT_MATCH_SOCKET', 'CONFIG_NF_SOCKET_IPV4',
  'CONFIG_NF_SOCKET_IPV6', 'CONFIG_NF_TABLES', 'CONFIG_NFT_META', 'CONFIG_NFT_CT']
const RULE_FAILURE_FLAGS = ['unsupportedRevision', 'missingKernelModule', 'missingExtension',
  'operationNotSupported', 'permissionDenied', 'invalidArgument']
const REFUSALS = new Set(['root_required', 'socket_mark_unavailable', 'user_identity_invalid', 'user_fixture_start_timeout',
  'user_fixture_invalid', 'ports_invalid', 'operation_invalid', 'probe_internal_failure',
  'preview_ingress_process_ended', 'preview_ingress_phase_timeout', 'preview_ingress_phase_invalid',
  'preview_ingress_positive_control_failed', 'outbound_target_invalid', 'outbound_probe_failed',
  'provider_control_failed',
  ...['ipv4', 'ipv6'].flatMap(family => ['tool_missing_', 'chain_unavailable_', 'socket_match_unavailable_',
    'nft_backend_unavailable_', 'reply_rule_unavailable_', 'output_unavailable_',
    'reject_unavailable_', 'input_unavailable_', 'rule_unverified_'].map(prefix => prefix + family))])
const safeCode = error => REFUSALS.has(error?.message) ? error.message : 'preview_ingress_probe_failed'
const providerListeners = value => Object.fromEntries(['49983', '50005'].map(port => [port, {
  listening: value?.[port]?.listening === true, allRoot: value?.[port]?.allRoot === true,
}]))

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
    policy: 'nft_output_reply_mark', policyScope: 'owned_fixture_ports_only',
    preListenerIsolationProven: false, agentPrivilegeBoundaryProven: false,
    before: {}, after: {}, outbound: null, providerControlRoundTrip: false, providerListenersPreserved: false,
    replacement: null, passed: false, rulesRemoved: false }
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
    if (value.tools) report.tools = Object.fromEntries(['iptables', 'ip6tables', 'nft'].map(name => [name, { present: value.tools?.[name]?.present === true,
      source: value.tools?.[name]?.source === 'private' ? 'private' : 'system',
      version: /^\d+\.\d+\.\d+$/.test(value.tools?.[name]?.version ?? '') ? value.tools[name].version : null,
      backend: ['nf_tables', 'legacy'].includes(value.tools?.[name]?.backend) ? value.tools[name].backend : 'unknown' }]))
    if (value.kernel) report.kernel = {
      release: /^[A-Za-z0-9_.+-]{1,128}$/.test(value.kernel.release ?? '') ? value.kernel.release : null,
      configSource: ['proc', 'boot'].includes(value.kernel.configSource) ? value.kernel.configSource : 'unavailable',
      options: Object.fromEntries(KERNEL_OPTIONS.map(name => [name,
        ['y', 'm', 'n'].includes(value.kernel.options?.[name]) ? value.kernel.options[name] : 'unknown'])),
    }
    if (value.ruleFailure) report.ruleFailure = {
      exitCode: Number.isInteger(value.ruleFailure.exitCode) && value.ruleFailure.exitCode >= 0
        && value.ruleFailure.exitCode <= 255 ? value.ruleFailure.exitCode : null,
      ...Object.fromEntries(RULE_FAILURE_FLAGS.map(name => [name, value.ruleFailure[name] === true])),
    }
    if (value.phase === 'failed') throw new Error(REFUSALS.has(value.code) ? value.code : 'probe_internal_failure')
    if (value.phase !== expected) throw new Error('preview_ingress_phase_invalid')
    return value
  }
  try {
    const ready = await phase('ready')
    const ports = ready.ports
    if (NAMES.some(name => !ports?.[name]) || Object.keys(ports).some(name => !NAMES.includes(name))
      || Object.values(ports).some(port => !Number.isInteger(port) || port <= 1024 || port >= 65536 || [49983, 50005].includes(port))
      || new Set(Object.values(ports)).size !== Object.keys(ports).length) throw new Error('ports_invalid')
    report.user = { canSetSocketMark: ready.user?.canSetSocketMark === true,
      sudoNonInteractiveRoot: ready.user?.sudoNonInteractiveRoot === true,
      noNewPrivileges: typeof ready.user?.noNewPrivileges === 'boolean' ? ready.user.noNewPrivileges : null }
    report.providerListenersBefore = providerListeners(ready.providerListeners)
    // Single bounded setup delay for envd's documented listener scan.
    await new Promise(accept => setTimeout(accept, 1500))
    for (const [name, port] of Object.entries(ports)) report.before[name] = await sample(sandbox, port, fetchImpl)
    if (NAMES.some(name => !report.before[name].markerMatched)) throw new Error('preview_ingress_positive_control_failed')
    await process.sendStdin('protect\n')
    const protectedReply = await phase('protected')
    report.rules = { ipv4: protectedReply.rules?.ipv4 === true, ipv6: protectedReply.rules?.ipv6 === true }
    report.providerListenersAfter = providerListeners(protectedReply.providerListeners)
    report.providerListenersPreserved = ['49983', '50005'].every(port =>
      ['listening', 'allRoot'].every(field => report.providerListenersBefore[port][field] === report.providerListenersAfter[port][field]))
    const provider = await sandbox.commands.run(`printf '${PROVIDER_CONTROL}'`, { user: 'user', timeoutMs: 10_000 })
    report.providerControlRoundTrip = provider.stdout === PROVIDER_CONTROL
    if (!report.providerControlRoundTrip || !report.providerListenersPreserved) throw new Error('provider_control_failed')
    await process.sendStdin(`outbound https://${sandbox.getHost(ports.rootMarked)}/\n`)
    const outbound = await phase('outbound')
    report.outbound = { status: Number.isInteger(outbound.status) && outbound.status >= 100 && outbound.status <= 599 ? outbound.status : null,
      markerMatched: outbound.markerMatched === true }
    for (const [name, port] of Object.entries(ports)) report.after[name] = await sample(sandbox, port, fetchImpl)
    await process.sendStdin('replace\n')
    const replacement = await phase('replaced')
    if (replacement.port !== ports.rootMarked) throw new Error('ports_invalid')
    report.replacement = await sample(sandbox, ports.rootMarked, fetchImpl)
    await process.sendStdin('finish\n')
    const finished = await phase('finished')
    report.rulesRemoved = finished.rulesRemoved === true
    report.passed = report.capabilities.netAdmin && report.rules.ipv4 && report.rules.ipv6
      && ['iptables', 'ip6tables'].every(name => report.tools[name].backend === 'nf_tables')
      && report.providerControlRoundTrip && report.providerListenersPreserved && report.outbound.markerMatched
      && report.after.rootMarked.markerMatched && !report.user.canSetSocketMark
      && NAMES.filter(name => name !== 'rootMarked').every(name => !report.after[name].markerMatched)
      && !report.replacement.markerMatched && report.rulesRemoved
    return report
  } catch (error) {
    report.failure = safeCode(error)
    error.evidence = report
    throw error
  } finally {
    try { await process.sendStdin('finish\n') } catch { /* VM teardown below remains mandatory. */ }
    await Promise.race([completion, new Promise(accept => setTimeout(accept, 1000))])
    // A rule insertion can fail before the normal finish phase. The owned VM
    // still must be killed, but retain its independent rule-cleanup receipt.
    const finished = receipts.findLast(value => value.phase === 'finished')
    if (finished) report.rulesRemoved = finished.rulesRemoved === true
  }
}

const cleanupMetadata = journal => ({ application: PURPOSE, issue: '1724', sourceCommit: journal.sourceCommit,
  fixtureId: journal.fixtureId, requestedTemplate: journal.requestedTemplate })

/** Only this invocation's exact metadata/VM may be destroyed. Static API reads
 * never connect to, resume or extend a machine. No account-wide cleanup. */
export async function cleanupOwnedProbe(journal, sourceCommit, { Sandbox, SandboxNotFoundError }, apiOptions = {}) {
  if (journal?.version !== 1 || journal.purpose !== PURPOSE || !SHA.test(sourceCommit)
    || journal.sourceCommit !== sourceCommit || !UUID.test(journal.fixtureId ?? '')
    || !ID.test(journal.requestedTemplate ?? '')
    || journal.sandboxId !== null && !ID.test(journal.sandboxId ?? '')) throw new Error('preview_ingress_cleanup_scope')
  const metadata = cleanupMetadata(journal)
  let sandboxId = journal.sandboxId
  if (!sandboxId) {
    // Creation may have succeeded despite a lost reply. Look up only the
    // unique, pre-journaled nonce; refuse ambiguity instead of sweeping VMs.
    const page = Sandbox.list({ ...apiOptions, query: { metadata }, limit: 2 })
    const found = await page.nextItems()
    if (page.hasNext || found.length > 1) throw new Error('preview_ingress_cleanup_scope')
    if (!found.length) return { stopped: false, outcome: 'creation_unconfirmed', scopeVerified: false }
    sandboxId = found[0].sandboxId
    if (!ID.test(sandboxId ?? '')) throw new Error('preview_ingress_cleanup_scope')
  }
  let info
  try { info = await Sandbox.getInfo(sandboxId, apiOptions) }
  catch (cause) {
    if (SandboxNotFoundError && cause instanceof SandboxNotFoundError)
      return { stopped: true, outcome: 'provider_already_absent', scopeVerified: false }
    throw new Error('preview_ingress_cleanup_read_failed', { cause })
  }
  if (info.sandboxId !== sandboxId || Object.entries(metadata).some(([key, value]) => info.metadata?.[key] !== value))
    throw new Error('preview_ingress_cleanup_scope')
  const killed = await Sandbox.kill(sandboxId, apiOptions)
  return { stopped: true, outcome: killed ? 'provider_kill_acknowledged' : 'provider_already_absent', scopeVerified: true }
}

async function writeReceipt(path, value) {
  // Atomic replacement keeps the original creation intent usable after a
  // runner/process interruption between provider creation and report output.
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  await rename(temporary, path)
}

async function readJournal(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error('preview_ingress_cleanup_scope')
  return JSON.parse(await readFile(path, 'utf8'))
}

async function main(args) {
  const options = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1]
    if (!['--template', '--output', '--cleanup'].includes(name) || !value || options.has(name))
      throw new Error('preview_ingress_configuration')
    options.set(name, value)
  }
  const template = options.get('--template'), output = options.get('--output'), cleanupPath = options.get('--cleanup')
  if (!output || Boolean(template) === Boolean(cleanupPath) || template && !ID.test(template)) throw new Error('preview_ingress_configuration')
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', maxBuffer: 200 }).trim()
  if (!SHA.test(sourceCommit)) throw new Error('preview_ingress_source_invalid')
  await mkdir(dirname(resolve(output)), { recursive: true, mode: 0o700 })
  const apiOptions = { apiKey: process.env.E2B_API_KEY, requestTimeoutMs: 15_000, retries: 0 }
  if (cleanupPath) {
    let cleanup, journal
    try { journal = await readJournal(cleanupPath) }
    catch (cause) {
      if (cause?.code !== 'ENOENT') throw new Error('preview_ingress_cleanup_journal', { cause })
      cleanup = { stopped: true, outcome: 'no_creation_requested', scopeVerified: false }
    }
    if (journal) {
      if (!apiOptions.apiKey) throw new Error('preview_ingress_configuration')
      try { cleanup = await cleanupOwnedProbe(journal, sourceCommit, await import('e2b'), apiOptions) }
      catch { cleanup = { stopped: false, outcome: 'cleanup_failed', scopeVerified: false } }
    }
    const binding = journal?.sourceCommit === sourceCommit && UUID.test(journal.fixtureId ?? '')
      && ID.test(journal.requestedTemplate ?? '') && (journal.sandboxId === null || ID.test(journal.sandboxId ?? ''))
      ? { fixtureId: journal.fixtureId, requestedTemplate: journal.requestedTemplate, sandboxId: journal.sandboxId } : {}
    await writeReceipt(output, { version: 1, purpose: PURPOSE, sourceCommit, ...binding, cleanup })
    if (!cleanup.stopped) throw new Error('preview_ingress_cleanup_failed')
    return
  }
  if (!apiOptions.apiKey) throw new Error('preview_ingress_configuration')
  const sdk = await import('e2b'), { Sandbox } = sdk
  const journalPath = `${output}.cleanup.json`
  const journal = { version: 1, purpose: PURPOSE, sourceCommit, fixtureId: randomUUID(),
    requestedTemplate: template, sandboxId: null }
  // Do not replace another attempt's cleanup target.
  await writeFile(journalPath, JSON.stringify(journal) + '\n', { mode: 0o600, flag: 'wx' })
  const report = { version: 1, purpose: PURPOSE, sourceCommit, fixtureId: journal.fixtureId, requestedTemplate: template,
    templateScope: ['claude', 'codex'].includes(template) ? 'official_alias_resolved_by_provider' : 'explicit_template_id',
    maximumLifetimeMs: 180_000, passed: false }
  let failure
  try {
    const sandbox = await Sandbox.create(template, { ...apiOptions, requestTimeoutMs: 45_000,
      proxy: process.env.HTTPS_PROXY ?? process.env.https_proxy,
      timeoutMs: 180_000, lifecycle: { onTimeout: 'kill', autoResume: false }, network: { allowPublicTraffic: true },
      metadata: cleanupMetadata(journal) })
    if (!ID.test(sandbox.sandboxId ?? '')) throw new Error('preview_ingress_cleanup_scope')
    journal.sandboxId = sandbox.sandboxId
    report.sandboxId = sandbox.sandboxId
    await writeReceipt(journalPath, journal)
    Object.assign(report, await probeMarkedIngress(sandbox, sourceCommit))
  } catch (error) {
    failure = error
    Object.assign(report, error.evidence ?? { failure: safeCode(error) })
  } finally {
    try { report.cleanup = await cleanupOwnedProbe(journal, sourceCommit, sdk, apiOptions) }
    catch (cause) { report.cleanup = { stopped: false, outcome: 'cleanup_failed', scopeVerified: false }; failure ??= new Error('preview_ingress_cleanup_failed', { cause }) }
    await writeReceipt(output, report)
  }
  if (failure || !report.passed || !report.cleanup.stopped) throw new Error('preview_ingress_probe_failed', failure ? { cause: failure } : undefined)
  console.log(JSON.stringify({ sourceCommit, passed: true, evidence: resolve(output) }))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => { console.error('preview_ingress_probe_failed'); process.exitCode = 1 })
}
