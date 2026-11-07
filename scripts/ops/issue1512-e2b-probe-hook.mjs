// Temporary anonymous catalogue boundaries, loaded with Node --import.
// Transparent observation: no network/FS restriction or child-control change.
import childProcess from 'node:child_process'
import { closeSync, openSync, readSync, realpathSync, writeSync } from 'node:fs'
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
// Fixed kernel accounting only. Never inspect argv, environments or user files.
function readKernel(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(8193), size = readSync(fd, buffer, 0, buffer.length, null)
    return size <= 8192 ? buffer.subarray(0, size).toString('utf8') : undefined
  } catch { return undefined }
  finally { if (fd !== undefined) { try { closeSync(fd) } catch { /* Observation only. */ } } }
}
// Pure observer boundary, also exercised with fake kernel files offline.
function createResourceObserver(read, emitResource, parentPid) {
  const roots = new Map(), sampled = new Set()
  const states = new Set(['R', 'S', 'D', 'Z', 'T', 't', 'X', 'I'])
  const waits = { '0': 'zero', futex_wait: 'futex', futex_wait_queue: 'futex', futex_wait_queue_me: 'futex',
    do_epoll_wait: 'epoll', ep_poll: 'epoll', pipe_read: 'pipe', do_wait: 'child_wait',
    io_schedule: 'io', folio_wait_bit_common: 'io', wait_on_page_bit_common: 'io', hrtimer_nanosleep: 'sleep' }
  const integer = value => typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined
  const put = (out, key, value) => { const n = integer(value); if (n !== undefined) out[key] = n }
  function stat(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return
    const raw = read(`/proc/${pid}/stat`)
    if (typeof raw !== 'string' || integer(raw.split(' ', 1)[0]) !== pid) return
    const end = raw.lastIndexOf(') ')
    if (end < 0) return
    // Drop comm completely; offsets follow docs.kernel.org/filesystems/proc.html.
    const fields = raw.slice(end + 2).trim().split(/\s+/)
    if (fields.length < 22) return
    const row = { pid, state: states.has(fields[0]) ? fields[0] : 'other' }
    for (const [key, index] of Object.entries({ ppid: 1, minFaults: 7, majorFaults: 9,
      utimeTicks: 11, stimeTicks: 12, startTicks: 19, rssPages: 21 })) put(row, key, fields[index])
    return row.ppid > 0 && row.startTicks !== undefined ? row : undefined
  }
  const same = (a, b) => a && b && a.pid === b.pid && a.ppid === b.ppid && a.startTicks === b.startTicks
  function processRow(identity, harness, depth) {
    const before = stat(identity.pid)
    if (!same(before, identity)) return
    const io = read(`/proc/${identity.pid}/io`) ?? ''
    const blocked = (read(`/proc/${identity.pid}/wchan`) ?? '').trim()
    const after = stat(identity.pid)
    if (!same(before, after)) return
    const row = { ...after, harness, depth, wait: Object.hasOwn(waits, blocked) ? waits[blocked] : 'other' }
    put(row, 'readBytes', /^read_bytes:\s*(\d+)\s*$/m.exec(io)?.[1])
    put(row, 'writeBytes', /^write_bytes:\s*(\d+)\s*$/m.exec(io)?.[1])
    return row
  }
  function system() {
    const row = {}, cpu = /^cpu\s+([^\n]+)$/m.exec(read('/proc/stat') ?? '')?.[1].trim().split(/\s+/)
    if (cpu) for (const [index, name] of ['cpuUserTicks', 'cpuNiceTicks', 'cpuSystemTicks', 'cpuIdleTicks',
      'cpuIowaitTicks', 'cpuIrqTicks', 'cpuSoftirqTicks', 'cpuStealTicks'].entries()) put(row, name, cpu[index])
    // PSI totals and cgroup cpu.stat times are microseconds. System CPU full
    // pressure is undefined, so only its some counter is meaningful here.
    for (const resource of ['cpu', 'memory', 'io']) {
      const raw = read(`/proc/pressure/${resource}`) ?? ''
      for (const kind of resource === 'cpu' ? ['some'] : ['some', 'full']) {
        put(row, `${resource}Pressure${kind === 'some' ? 'Some' : 'Full'}Us`, new RegExp(`^${kind} [^\\n]* total=(\\d+)\\s*$`, 'm').exec(raw)?.[1])
      }
    }
    put(row, 'memAvailableKiB', /^MemAvailable:\s*(\d+) kB\s*$/m.exec(read('/proc/meminfo') ?? '')?.[1])
    put(row, 'cgroupMemoryBytes', (read('/sys/fs/cgroup/memory.current') ?? '').trim())
    const cpuStat = read('/sys/fs/cgroup/cpu.stat') ?? ''
    for (const [key, name] of Object.entries({ usage_usec: 'cgroupUsageUs', user_usec: 'cgroupUserUs', system_usec: 'cgroupSystemUs',
      nr_periods: 'cgroupPeriods', nr_throttled: 'cgroupThrottledPeriods', throttled_usec: 'cgroupThrottledUs' })) {
      put(row, name, new RegExp(`^${key} (\\d+)\\s*$`, 'm').exec(cpuStat)?.[1])
    }
    return row
  }
  return {
    track(pid, harness) {
      if (!['claude_code', 'codex'].includes(harness) || roots.has(harness)) return
      try {
        const identity = stat(pid)
        if (identity?.ppid === parentPid) roots.set(harness, { pid, ppid: identity.ppid, startTicks: identity.startTicks })
      } catch { /* Observation only. */ }
    },
    sample(sample) {
      if (!['after_5s', 'after_15s', 'cli_deadline'].includes(sample) || sampled.has(sample) || sampled.size >= 3) return
      sampled.add(sample)
      const began = performance.now()
      try {
        const rows = [], live = []
        for (const [harness, identity] of roots) {
          const row = processRow(identity, harness, 0)
          if (row) { rows.push(row); live.push([harness, identity]) }
        }
        for (const [harness, identity] of live) {
          // Only direct descendants listed by this owned leader, then recheck ppid.
          const ids = (read(`/proc/${identity.pid}/task/${identity.pid}/children`) ?? '').trim().split(/\s+/).slice(0, 12)
          for (const value of ids) {
            if (rows.length >= 12) break
            const child = stat(integer(value))
            if (!child || child.ppid !== identity.pid || rows.some(row => row.pid === child.pid)) continue
            const row = processRow(child, harness, 1)
            if (row && same(stat(identity.pid), identity)) rows.push(row)
          }
        }
        const vm = system()
        for (const row of rows) emitResource({ phase: 'process_snapshot', sample, ...row })
        emitResource({ phase: 'vm_snapshot', sample, trackedProcesses: rows.length,
          snapshotMs: Math.round(performance.now() - began), ...vm })
      } catch { /* Missing/revoked kernel counters never change probe execution. */ }
    },
  }
}
// End bounded kernel observer.
const resourceObserver = createResourceObserver(readKernel, emit, process.pid)
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
  resourceObserver.track(record.pid, harness)
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
  const timer = setTimeout(() => {
    snapshot(record, 'deadline_snapshot')
    if (harness !== 'other') resourceObserver.sample('cli_deadline')
  }, 20000)
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
    if (ms === 5000 || ms === 15000) resourceObserver.sample(ms === 5000 ? 'after_5s' : 'after_15s')
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
