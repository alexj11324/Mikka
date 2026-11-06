// Temporary anonymous catalogue diagnostics, loaded with Node --import.
// No credentials, model calls, child-control changes, or private CLI output.
import childProcess from 'node:child_process'
import { writeSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const began = performance.now()
const originalSpawn = childProcess.spawn
const records = []
const signals = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'SIGBUS'])
const resourceTypes = new Set(['PipeWrap', 'ProcessWrap', 'Timeout', 'TCPSocketWrap', 'TCPServerWrap', 'FSWatcher', 'FSEventWrap', 'TTYWrap'])
const elapsed = () => Math.round(performance.now() - began)
function emit(value) {
  try { writeSync(2, `mikka-model-probe ${JSON.stringify({ version: 1, elapsedMs: elapsed(), ...value })}\n`) } catch { /* Observation cannot fail the command. */ }
}
function family(args) {
  if (!Array.isArray(args)) return undefined
  if (args.length === 1 && args[0] === 'app-server') return 'codex'
  if (JSON.stringify(args) === JSON.stringify(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'])) return 'claude_code'
  return undefined
}
function snapshot(record, phase) {
  emit({ harness: record.harness, phase, pid: record.pid, stdoutBytes: record.stdoutBytes,
    catalogueSeen: record.catalogueSeen, catalogueCount: record.catalogueCount,
    exited: record.exited, closed: record.closed, exitCode: record.exitCode, signal: record.signal })
}

childProcess.spawn = function (...args) {
  const harness = family(args[1])
  if (!harness || records.length >= 2) return Reflect.apply(originalSpawn, this, args)
  let child
  try { child = Reflect.apply(originalSpawn, this, args) }
  catch (error) { emit({ harness, phase: 'spawn_throw' }); throw error }
  const record = { harness, pid: Number.isSafeInteger(child.pid) ? child.pid : null, stdoutBytes: 0,
    catalogueSeen: false, catalogueCount: null, exited: false, closed: false, exitCode: null, signal: null }
  records.push(record)
  snapshot(record, 'spawn')
  let buffer = '', parseDisabled = false
  child.stdout?.on('data', chunk => {
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
  child.on('error', () => snapshot(record, 'spawn_error'))
  child.on('exit', (code, signal) => {
    record.exited = true; record.exitCode = Number.isSafeInteger(code) ? code : null
    record.signal = signals.has(signal) ? signal : signal ? 'other' : null
    snapshot(record, 'exit')
  })
  const timer = setTimeout(() => snapshot(record, 'deadline_snapshot'), 20000)
  timer.unref()
  child.on('close', () => { record.closed = true; clearTimeout(timer); buffer = ''; snapshot(record, 'close') })
  return child
}
syncBuiltinESMExports()
emit({ phase: 'entry' })
const parentTimer = setTimeout(() => {
  const resources = {}
  for (const type of process.getActiveResourcesInfo()) {
    const key = resourceTypes.has(type) ? type : 'other'
    resources[key] = (resources[key] ?? 0) + 1
  }
  emit({ phase: 'parent_deadline_snapshot', resources })
  for (const record of records) snapshot(record, 'parent_deadline_child')
}, 40000)
parentTimer.unref()
process.once('exit', code => {
  clearTimeout(parentTimer)
  emit({ phase: 'parent_exit', exitCode: Number.isSafeInteger(code) ? code : null,
    spawned: records.length, catalogues: records.filter(record => record.catalogueSeen).length,
    exited: records.filter(record => record.exited).length, closed: records.filter(record => record.closed).length })
})
