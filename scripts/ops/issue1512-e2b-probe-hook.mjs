// Temporary anonymous catalogue boundaries, loaded with Node --import.
// Transparent observation: no network/FS restriction or child-control change.
import childProcess from 'node:child_process'
import { realpathSync, writeSync } from 'node:fs'
import { registerHooks, syncBuiltinESMExports } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const began = performance.now(), records = [], observedChildren = new WeakSet()
const signals = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'SIGBUS'])
const resourceTypes = new Set(['PipeWrap', 'ProcessWrap', 'Timeout', 'TCPSocketWrap', 'TCPServerWrap', 'FSWatcher', 'FSEventWrap', 'TTYWrap'])
const elapsed = () => Math.round(performance.now() - began)
let emitted = 0
function emit(value) {
  if (emitted++ >= 120 && value.phase !== 'parent_exit') return
  try { writeSync(2, `mikka-model-probe ${JSON.stringify({ version: 1, elapsedMs: elapsed(), ...value })}\n`) } catch { /* Observation cannot fail the command. */ }
}
function family(args) {
  if (!Array.isArray(args)) return 'other'
  if (args.length === 1 && args[0] === 'app-server') return 'codex'
  if (JSON.stringify(args) === JSON.stringify(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'])) return 'claude_code'
  return 'other'
}
function snapshot(record, phase) {
  emit({ harness: record.harness, api: record.api, phase, pid: record.pid,
    ...(record.harness !== 'other' ? { stdoutBytes: record.stdoutBytes, catalogueSeen: record.catalogueSeen, catalogueCount: record.catalogueCount } : {}),
    exited: record.exited, closed: record.closed, exitCode: record.exitCode, signal: record.signal })
}
function observeChild(child, harness, api) {
  if (!child?.once || observedChildren.has(child) || records.length >= 16) return
  observedChildren.add(child)
  const record = { harness, api, pid: Number.isSafeInteger(child.pid) ? child.pid : null, stdoutBytes: 0,
    catalogueSeen: false, catalogueCount: null, exited: false, closed: false, exitCode: null, signal: null }
  records.push(record)
  snapshot(record, 'spawn')
  let buffer = '', parseDisabled = false
  // Only the existing catalogue exchange already consumes stdout. Never drain
  // any unrelated child's pipe just to observe it.
  if (harness !== 'other') child.stdout?.on('data', chunk => {
    record.stdoutBytes = Math.min(Number.MAX_SAFE_INTEGER, record.stdoutBytes + Buffer.byteLength(chunk))
    if (record.catalogueSeen || parseDisabled) return
    buffer += chunk.toString('utf8')
    if (buffer.length > 65536) { buffer = ''; parseDisabled = true; snapshot(record, 'catalogue_scan_bounded'); return }
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
      let message
      try { message = JSON.parse(line) } catch { continue }
      const catalogue = harness === 'codex' && message?.id === 2 ? message.result?.data
        : harness === 'claude_code' && message?.type === 'control_response' && message.response?.subtype === 'success' ? message.response.response?.models : undefined
      if (!Array.isArray(catalogue)) continue
      record.catalogueSeen = true; record.catalogueCount = Math.min(catalogue.length, 500)
      buffer = ''; snapshot(record, 'catalogue_received'); break
    }
  })
  child.once('error', () => snapshot(record, 'spawn_error'))
  child.once('exit', (code, signal) => {
    record.exited = true; record.exitCode = Number.isSafeInteger(code) ? code : null
    record.signal = signals.has(signal) ? signal : signal ? 'other' : null
    snapshot(record, 'exit')
  })
  const timer = setTimeout(() => snapshot(record, 'deadline_snapshot'), 20000)
  timer.unref()
  child.once('close', () => { record.closed = true; clearTimeout(timer); buffer = ''; snapshot(record, 'close') })
}
function wrap(original, api) {
  return function (...args) {
    const harness = family(args[1])
    // A synchronous spawn/execFile can stall before returning its child.
    emit({ phase: 'call_begin', api, harness })
    let result
    try { result = Reflect.apply(original, this, args) }
    catch (error) { emit({ phase: 'call_throw', api, harness }); throw error }
    emit({ phase: 'call_return', api, harness })
    observeChild(result?.child ?? result, harness, api)
    return result
  }
}
for (const api of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) {
  const original = childProcess[api], wrapped = wrap(original, api)
  const custom = Object.getOwnPropertyDescriptor(original, promisify.custom)
  if (custom?.value) Object.defineProperty(wrapped, promisify.custom, { ...custom, value: wrap(custom.value, `${api}Promisified`) })
  childProcess[api] = wrapped
}
syncBuiltinESMExports()

// E2B's active worker is a symlink into a versioned release. Node's module
// loader uses its real path, so observation must use that same canonical URL.
const bundleURL = pathToFileURL(realpathSync(resolve(process.argv[1]))).href
const standaloneProbe = bundleURL.endsWith('/cloud-model-probe.js')
const classify = url => url === bundleURL ? 'worker_bundle'
  : url.endsWith('/@anthropic-ai/claude-agent-sdk/sdk.mjs') ? 'claude_sdk'
    : url.endsWith('/pino/pino.js') ? 'pino' : undefined
// Only the Mikka bundle receives in-memory fixed markers. No file is changed,
// and no official CLI/SDK source is transformed or replaced.
const marker = Symbol.for('mikka.issue1512.probe-boundary')
globalThis[marker] = phase => emit({ phase })
const statement = phase => `globalThis[Symbol.for('mikka.issue1512.probe-boundary')]('${phase}');`
function mark(source, needle, phase, after = false) {
  if (source.split(needle).length !== 2) {
    emit({ phase: 'marker_unavailable', marker: phase })
    return source
  }
  return source.replace(needle, after ? `${needle}\n${statement(phase)}` : `${statement(phase)}\n${needle}`)
}
registerHooks({
  load(url, context, nextLoad) {
    const module = classify(url)
    if (module) emit({ phase: 'module_load_begin', module })
    let result
    try { result = nextLoad(url, context) }
    catch (error) { if (module) emit({ phase: 'module_load_throw', module }); throw error }
    if (module) emit({ phase: 'module_load_return', module })
    if (url !== bundleURL || result.format !== 'module') return result
    let source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
    source = statement('bundle_evaluation_begin') + '\n'
      + (standaloneProbe ? statement('probe_branch_enter') + '\n' : '') + source
    if (!standaloneProbe) source = mark(source, 'if (process.argv.includes("--probe-models")) {', 'probe_branch_enter')
    source = mark(source, 'async function probeHostedRuntimeModels(passed) {', 'hosted_probe_enter', true)
    source = mark(source, 'const binaries = hostedBinaries(passed);', 'binaries_resolved', true)
    source = mark(source, 'const before = fingerprint(binaries);', 'fingerprint_ready', true)
    source = mark(source, 'const settled = await Promise.allSettled(Object.entries(binaries).map(', 'probe_scratch_ready')
    return { ...result, source }
  },
})
emit({ phase: 'entry' })
const parentTimers = [5000, 15000, 30000].map(ms => {
  const timer = setTimeout(() => {
    const resources = {}
    for (const type of process.getActiveResourcesInfo()) {
      const key = resourceTypes.has(type) ? type : 'other'
      resources[key] = (resources[key] ?? 0) + 1
    }
    emit({ phase: 'parent_deadline_snapshot', resources })
    for (const record of records) snapshot(record, 'parent_deadline_child')
  }, ms)
  timer.unref()
  return timer
})
process.once('exit', code => {
  parentTimers.forEach(clearTimeout)
  emit({ phase: 'parent_exit', exitCode: Number.isSafeInteger(code) ? code : null,
    spawned: records.length, catalogues: records.filter(record => record.catalogueSeen).length,
    exited: records.filter(record => record.exited).length, closed: records.filter(record => record.closed).length })
})
