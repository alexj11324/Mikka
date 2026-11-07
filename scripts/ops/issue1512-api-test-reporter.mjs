// Temporary #1512 diagnostic: fixed metadata only; no test names, messages, stack or payload.
export const RECORD_PREFIX = 'MIKKA_I1512_API_RECORD '
export const PHASE_PREFIX = 'MIKKA_I1512_ALIAS_PHASE '
export const ALIAS_FILE = 'apps/api/scripts/workflow-development-aliases.test.mjs'
export const PHASES = [
  'module_ready', 'first_begin', 'first_fixture_ready', 'first_cleanup_begin', 'first_cleanup_end',
  'second_begin', 'second_fixture_ready', 'builder_import_begin', 'builder_import_end',
  'builder_construct_begin', 'builder_construct_end', 'builder_build_begin', 'builder_build_end',
  'alias_compile_begin', 'alias_compile_end', 'health_child_begin', 'health_child_end',
  'second_cleanup_begin', 'second_cleanup_end', 'third_begin', 'third_end',
]
const signals = new Set(['SIGABRT', 'SIGBUS', 'SIGFPE', 'SIGILL', 'SIGINT', 'SIGKILL', 'SIGQUIT', 'SIGSEGV', 'SIGTERM', 'SIGTRAP'])
const failures = new Set(['testCodeFailure', 'subtestsFailed', 'cancelledByParent', 'testTimeoutFailure', 'hookFailed', 'unhandledRejection', 'uncaughtException', 'testAborted', 'parentAlreadyFinished'])
const errorCodes = new Set(['ERR_TEST_FAILURE', 'ERR_ASSERTION', 'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_WORKER_OUT_OF_MEMORY', 'ERR_WORKER_UNSUPPORTED_OPERATION', 'ENOENT', 'EACCES', 'ENOSPC'])
const errorNames = new Set(['Error', 'AssertionError', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError'])
const countKeys = ['cancelled', 'failed', 'passed', 'skipped', 'suites', 'tests', 'todo', 'topLevel']
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const finite = value => Number.isFinite(value) && value >= 0 ? value : null
const get = (object, key) => { try { return object?.[key] } catch { return undefined } }
const closed = (set, value) => typeof value === 'string' && set.has(value) ? value : null
export function fileLabel(file, root) {
  if (typeof file !== 'string' || typeof root !== 'string' || !root.startsWith('/')) return null
  const prefix = root.replace(/\/+$/, '') + '/'
  if (!file.startsWith(prefix)) return null
  const relative = file.slice(prefix.length)
  return relative.length <= 240 && !relative.split('/').includes('..') &&
    /^(?:apps\/api|lib|scripts|tests)\/[A-Za-z0-9_./-]+\.test\.(?:mjs|cjs|js|ts|tsx)$/.test(relative) ? relative : null
}
function errorFields(error) {
  const exit = get(error, 'exitCode')
  return {
    name: closed(errorNames, get(error, 'name')), code: closed(errorCodes, get(error, 'code')),
    failureType: closed(failures, get(error, 'failureType')),
    exitCode: Number.isInteger(exit) && exit >= 0 && exit <= 255 ? exit : null,
    signal: closed(signals, get(error, 'signal')),
  }
}
export function projectEvent(event, root) {
  const type = get(event, 'type'), data = get(event, 'data'), file = fileLabel(get(data, 'file'), root)
  if (type === 'test:fail') {
    const error = get(get(data, 'details'), 'error')
    return [{ kind: 'failure', file, line: integer(get(data, 'line')), column: integer(get(data, 'column')),
      error: errorFields(error), cause: errorFields(get(error, 'cause')) }]
  }
  if (type === 'test:summary') {
    const original = get(data, 'counts'), counts = Object.fromEntries(countKeys.map(key => [key, integer(get(original, key))]))
    const durationMs = finite(get(data, 'duration_ms')), success = get(data, 'success')
    if (Object.values(counts).includes(null) || durationMs === null || typeof success !== 'boolean')
      return [{ kind: 'invalid_summary' }]
    return [{ kind: 'summary', file, aggregate: get(data, 'file') === undefined, counts, durationMs, success }]
  }
  if (type === 'test:pass' && file === ALIAS_FILE)
    return [{ kind: 'alias_pass', file, line: integer(get(data, 'line')), durationMs: finite(get(get(data, 'details'), 'duration_ms')) }]
  if ((type === 'test:stderr' || type === 'test:stdout') && file === ALIAS_FILE) {
    const message = get(data, 'message')
    if (typeof message !== 'string') return []
    if (message.length > 16384) return [{ kind: 'alias_diagnostic_oversize' }]
    const result = []
    for (const line of message.split(/\r?\n/)) {
      if (line === 'fatal error: all goroutines are asleep - deadlock!')
        result.push({ kind: 'native_diagnostic', code: 'go_deadlock', file })
      if (!line.startsWith(PHASE_PREFIX)) continue
      try {
        const item = JSON.parse(line.slice(PHASE_PREFIX.length))
        if (Object.keys(item).sort().join(',') !== 'code,elapsedMs,event,phase,pid,sequence' ||
            !['phase', 'before_exit', 'exit', 'uncaught_exception'].includes(item.event) ||
            !PHASES.includes(item.phase) || integer(item.pid) === null || item.pid === 0 ||
            integer(item.sequence) === null || finite(item.elapsedMs) === null ||
            !(item.code === null || Number.isInteger(item.code) && item.code >= 0 && item.code <= 255))
          throw new Error('INVALID_PHASE')
        result.push({ kind: 'phase', file, event: item.event, phase: item.phase,
          pid: item.pid, sequence: item.sequence, elapsedMs: item.elapsedMs, code: item.code })
      } catch { result.push({ kind: 'invalid_phase' }) }
    }
    return result
  }
  return []
}

const keysAre = (value, names) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...names].sort().join(',')
const nullableInteger = value => value === null || integer(value) !== null
const nullableFinite = value => value === null || finite(value) !== null
export function isProjectedRecord(record) {
  if (!record || typeof record !== 'object') return false
  const fileOK = file => file === null || fileLabel('/source/' + file, '/source') === file
  if (record.kind === 'failure') return keysAre(record, ['kind','file','line','column','error','cause']) &&
    fileOK(record.file) && nullableInteger(record.line) && nullableInteger(record.column) &&
    [record.error, record.cause].every(error => keysAre(error, ['name','code','failureType','exitCode','signal']) &&
      JSON.stringify(errorFields(error)) === JSON.stringify(error))
  if (record.kind === 'summary') return keysAre(record, ['kind','file','aggregate','counts','durationMs','success']) &&
    fileOK(record.file) && typeof record.aggregate === 'boolean' && (!record.aggregate || record.file === null) &&
    keysAre(record.counts, countKeys) && countKeys.every(key => integer(record.counts[key]) !== null) &&
    finite(record.durationMs) !== null && typeof record.success === 'boolean'
  if (record.kind === 'alias_pass') return keysAre(record, ['kind','file','line','durationMs']) &&
    record.file === ALIAS_FILE && nullableInteger(record.line) && nullableFinite(record.durationMs)
  if (record.kind === 'native_diagnostic') return keysAre(record, ['kind','code','file']) &&
    record.code === 'go_deadlock' && record.file === ALIAS_FILE
  if (record.kind === 'phase') return keysAre(record, ['kind','file','event','phase','pid','sequence','elapsedMs','code']) &&
    record.file === ALIAS_FILE && ['phase','before_exit','exit','uncaught_exception'].includes(record.event) &&
    PHASES.includes(record.phase) && integer(record.pid) !== null && record.pid > 0 &&
    integer(record.sequence) !== null && finite(record.elapsedMs) !== null &&
    (record.code === null || Number.isInteger(record.code) && record.code >= 0 && record.code <= 255)
  return ['invalid_summary','invalid_phase','alias_diagnostic_oversize'].includes(record.kind) && keysAre(record, ['kind'])
}

export default async function* reporter(source) {
  const root = process.env.MIKKA_I1512_DIAGNOSTIC_SOURCE
  for await (const event of source)
    for (const item of projectEvent(event, root)) yield RECORD_PREFIX + JSON.stringify(item) + '\n'
}
