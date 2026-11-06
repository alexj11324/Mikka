import childProcess from 'node:child_process'
import { appendFileSync, readdirSync, readFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { basename } from 'node:path'

const began = performance.now(), file = '/tmp/mikka1505-probe.trace'
const rows = new Map()
const record = (event, fields = {}) => appendFileSync(file, JSON.stringify({ event, ms: Math.round(performance.now() - began), ...fields }) + '\n')
const spawn = childProcess.spawn
childProcess.spawn = function (binary, args, options) {
  const child = spawn.call(this, binary, args, options)
  const id = rows.size + 1, name = basename(String(binary))
  const harness = /codex/i.test(name) ? 'codex' : /claude/i.test(name) ? 'claude_code' : 'other'
  if (child.pid) rows.set(child.pid, { id, harness })
  record('spawn', { id, harness, pid: child.pid ?? null })
  const write = child.stdin?.write
  if (write) child.stdin.write = function (chunk, ...rest) {
    try {
      const value = JSON.parse(String(chunk))
      const method = ['initialize', 'initialized', 'model/list'].includes(value.method) ? value.method
        : value.type === 'control_request' && value.request?.subtype === 'initialize' ? 'claude_initialize' : 'other'
      record('request', { id, method })
    } catch { record('request_unparsed', { id }) }
    return write.call(this, chunk, ...rest)
  }
  let buffer = ''
  child.stdout?.on('data', chunk => {
    buffer += chunk.toString()
    let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      try {
        const value = JSON.parse(line)
        const phase = value.id === 1 ? 'codex_initialize' : value.id === 2 ? 'codex_models'
          : value.type === 'control_response' ? 'claude_control' : 'other'
        record('response', { id, phase, modelsPresent: Array.isArray(value.result?.data) || Array.isArray(value.response?.response?.models) })
      } catch { record('response_unparsed', { id }) }
    }
  })
  child.on('error', () => record('child_error', { id }))
  child.on('exit', (code, signal) => record('child_exit', { id, code, signal }))
  child.on('close', (code, signal) => record('child_close', { id, code, signal }))
  return child
}
syncBuiltinESMExports()
const kill = process.kill
process.kill = function (pid, signal) {
  const child = rows.get(Math.abs(pid))
  if (child) record('signal', { id: child.id, group: pid < 0, signal })
  return kill.call(this, pid, signal)
}
const output = process.stdout.write
process.stdout.write = function (chunk, ...rest) {
  try { const value = JSON.parse(String(chunk)); if (Array.isArray(value)) record('catalogue_output', { harnesses: value.length }) } catch {}
  return output.call(this, chunk, ...rest)
}
const state = () => {
  const processes = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const text = readFileSync(`/proc/${name}/stat`, 'utf8'), fields = text.slice(text.lastIndexOf(')') + 2).split(' ')
      processes.push({ pid: Number(name), state: fields[0], parent: Number(fields[1]), group: Number(fields[2]) })
    } catch {}
  }
  const tracked = new Set([process.pid, ...rows.keys()])
  for (let pass = 0; pass < 8; pass++) for (const row of processes) if (tracked.has(row.parent)) tracked.add(row.pid)
  record('state', { processes: processes.filter(row => tracked.has(row.pid)), handles: process._getActiveHandles().map(value => value.constructor.name) })
}
record('trace_started')
setInterval(state, 5000).unref()
process.on('beforeExit', () => { state(); record('before_exit') })
process.on('exit', code => record('process_exit', { code }))
