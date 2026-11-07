// Closed metadata for the isolated fixture report. No message, response, URL,
// argument, function name, absolute path or raw stack belongs in this output.
import { closeSync, constants, fstatSync, openSync, readFileSync, writeSync } from 'node:fs'
import { Server } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACTION_ERROR_CODES } from '../../lib/action-result.ts'

const handlers = new Set(['route', 'extension', 'health', 'observations', 'streaming_scenario', 'streaming_control',
  'scenario', 'scenario_device', 'subscription_model', 'subscription_prompt', 'subscription_answer', 'subscription_chunks',
  'language_model', 'decisions', 'decisions_push', 'decisions_outcome', 'decisions_tier', 'github', 'synthetic_codex'])
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'RPC'])
const operations = new Set(['create_issue', 'list_agents', 'dispatch_run', 'get_run', 'get_issue',
  'prepare', 'models', 'usage', 'quota', 'nativeContext', 'nativeAuth', 'executeStream',
  'initialize', 'model_list', 'oauth_login', 'thread_start', 'turn_start', 'fixture_write', 'git_validate', 'git_commit', 'git_push', 'pr_create', 'pr_checks', 'mcp_submit'])
const names = new Set(['Error', 'TypeError', 'SyntaxError', 'RangeError', 'AssertionError', 'AbortError', 'AggregateError', 'ActionFailureError', 'WorkerRefusal'])
const codes = new Set([...ACTION_ERROR_CODES, 'ERR_ASSERTION', 'ERR_MODULE_NOT_FOUND', 'ERR_INVALID_ARG_TYPE', 'ENOENT', 'EACCES',
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ABORT_ERR', 'subscription_fixture_refused',
  'githubReconnectRequired', 'repositoryRequired', 'machineUnavailable', 'modelNotAllowed', 'factoryLifecycleUnavailable',
  'agentProfileUnavailable', 'agentProfilePinConflict', 'MODEL_RESULT_REFUSED', 'MODEL_TOOL_MISSING',
  'MODEL_DESTINATION_MISMATCH', 'MODEL_IDENTITY_MISSING', 'MODEL_RUN_NOT_QUEUED', 'MODEL_COMPLETION_MISMATCH',
  'SYNTHETIC_GIT_ORIGIN_REQUIRED', 'SYNTHETIC_DELIVERY_CONTEXT_REQUIRED', 'SYNTHETIC_REPOSITORY_REQUIRED', 'SYNTHETIC_GIT_REWRITE_REQUIRED',
  'SYNTHETIC_PUSH_RECEIPT_REQUIRED', 'SYNTHETIC_PR_RECEIPT_REQUIRED', 'SYNTHETIC_CLEAN_WORKTREE_REQUIRED', 'SYNTHETIC_CODEX_METHOD_REQUIRED',
  'SYNTHETIC_CODEX_HOME_REQUIRED', 'SYNTHETIC_CODEX_AUTH_FILE_REFUSED', 'SYNTHETIC_CODEX_SHELL_REFUSED', 'SYNTHETIC_CODEX_MCP_REQUIRED',
  'SYNTHETIC_CODEX_SUBMIT_REFUSED', 'SYNTHETIC_CODEX_SUBMIT_REQUIRED', 'SYNTHETIC_COMMAND_FAILED', 'SYNTHETIC_FIXTURE_FAILED'])
const reasons = new Set(['noModels', 'cloudNotConfigured', 'cloudModelsUnknown', 'cloudModelNotReported', 'noDevice', 'checking', 'unavailable'])
const sources = new Set(['diagnostics.mjs', 'services.mjs', 'model.mjs', 'subscription.mjs', 'subscription-worker.mjs',
  'trace-chain.mjs', 'trace-codex.mjs', 'fixture.test.mjs'])
const escapedDirectory = dirname(fileURLToPath(import.meta.url)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const frame = new RegExp(`(?:file:\\/\\/)?${escapedDirectory}/([a-z0-9.-]+\\.mjs):([0-9]{1,5}):([0-9]{1,5})(?:\\)|$)`)

/** The isolated API's Node parser can reject a request before any route runs.
 * Observe its closed code without installing a listener, which would suppress
 * Node's default 400 response. Never inspect rawPacket, headers or message. */
export function observeTraceHttpParser(sink = value => console.info(JSON.stringify({ traceFixtureParser: value }))) {
  const original = Server.prototype.emit
  const codes = new Set(['HPE_INVALID_METHOD', 'HPE_INVALID_URL', 'HPE_INVALID_VERSION', 'HPE_INVALID_CONSTANT',
    'HPE_INVALID_HEADER_TOKEN', 'HPE_UNEXPECTED_CONTENT_LENGTH', 'HPE_INVALID_CONTENT_LENGTH', 'HPE_INVALID_CHUNK_SIZE',
    'HPE_INVALID_EOF_STATE', 'HPE_HEADER_OVERFLOW', 'HPE_CLOSED_CONNECTION', 'HPE_INVALID_TRANSFER_ENCODING', 'ECONNRESET'])
  let remaining = 64, active = true
  function observed(event, ...args) {
    if (active && event === 'clientError' && remaining > 0) {
      remaining--
      try {
        const error = args[0]
        sink({ code: codes.has(error?.code) ? error.code : 'OTHER',
          ...(Number.isSafeInteger(error?.bytesParsed) && error.bytesParsed >= 0 && error.bytesParsed <= 2_147_483_647 ? { bytesParsed: error.bytesParsed } : {}) })
      } catch { /* Preserve Node's parser error handling and original event. */ }
    }
    return Reflect.apply(original, this, [event, ...args])
  }
  Server.prototype.emit = observed
  return () => { active = false; if (Server.prototype.emit === observed) Server.prototype.emit = original }
}

function failureMetadata(value) {
  return {
    handler: handlers.has(value?.handler) ? value.handler : 'route',
    method: methods.has(value?.method) ? value.method : 'OTHER',
    name: names.has(value?.name) ? value.name : 'Error',
    ...(codes.has(value?.code) ? { code: value.code } : {}),
    ...(operations.has(value?.operation) ? { operation: value.operation } : {}),
    ...(codes.has(value?.sourceCode) ? { sourceCode: value.sourceCode } : {}),
    ...(reasons.has(value?.sourceReason) ? { sourceReason: value.sourceReason } : {}),
    source: (Array.isArray(value?.source) ? value.source : []).slice(0, 3).flatMap(location =>
      typeof location?.file === 'string' && location.file.startsWith('tests/mvp/') && sources.has(location.file.slice('tests/mvp/'.length))
        && Number.isInteger(location.line) && location.line >= 1 && location.line <= 10_000
        && Number.isInteger(location.column) && location.column >= 1 && location.column <= 4096
        ? [{ file: location.file, line: location.line, column: location.column }] : []),
  }
}

export function fixtureFailure(error, handler = 'route', method) {
  const source = []
  if (typeof error?.stack === 'string') for (const line of error.stack.slice(0, 16_384).split('\n').slice(1, 16)) {
    if (!/^\s+at\s/.test(line)) continue
    const found = frame.exec(line)
    if (!found || !sources.has(found[1])) continue
    const row = Number(found[2]), column = Number(found[3])
    if (row < 1 || row > 10_000 || column < 1 || column > 4096) continue
    source.push({ file: `tests/mvp/${found[1]}`, line: row, column })
    if (source.length === 3) break
  }
  return failureMetadata({ handler, method, name: error?.name, code: error?.code, operation: error?.fixtureOperation,
    sourceCode: error?.sourceCode, sourceReason: error?.sourceReason, source })
}

/** Owned peer-only evidence. Keep no command, stderr, prompt or raw stack. */
export function recordPeerFailure(directory, error, operation) {
  const firstLine = typeof error?.message === 'string' ? error.message.split('\n', 1)[0] : ''
  const code = codes.has(firstLine) ? firstLine : codes.has(error?.code) ? error.code
    : typeof error?.code === 'number' ? 'SYNTHETIC_COMMAND_FAILED' : 'SYNTHETIC_FIXTURE_FAILED'
  const metadata = fixtureFailure({ name: error?.name, stack: error?.stack, code, fixtureOperation: operation }, 'synthetic_codex', 'RPC')
  let fd
  try {
    fd = openSync(join(directory, 'trace-peer-failures.jsonl'), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600)
    const stat = fstatSync(fd)
    if (stat.isFile() && stat.nlink === 1 && (stat.mode & 0o077) === 0 && stat.size < 65_536) writeSync(fd, JSON.stringify(metadata) + '\n')
  } catch { /* Diagnostic IO must not replace the original fixture failure. */ }
  finally { if (fd !== undefined) closeSync(fd) }
}

export function readPeerFailures(directory) {
  let fd
  try {
    fd = openSync(join(directory, 'trace-peer-failures.jsonl'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 70_000) return []
    return readFileSync(fd, 'utf8').trim().split('\n').slice(0, 16).flatMap(line => {
      try { return [failureMetadata(JSON.parse(line))] } catch { return [] }
    })
  } catch { return [] }
  finally { if (fd !== undefined) closeSync(fd) }
}

const rpcMethods = new Set(['initialize', 'notifications/initialized', 'tools/list', 'tools/call'])
const rpcCodes = new Set([-32700, -32600, -32601, -32602, -32603, -32000, -32001])
const rpcErrors = new Map([
  ['Parse error: Invalid JSON', 'json_parse'],
  ['Parse error: Invalid JSON-RPC message', 'jsonrpc_shape'],
  ['Bad Request: Server not initialized', 'not_initialized'],
  ['Bad Request: Mcp-Session-Id header is required', 'session_missing'],
  ['Session not found', 'session_unknown'],
  ['Invalid Request: Server already initialized', 'already_initialized'],
  ['Invalid Request: Only one initialization request is allowed', 'multiple_initialize'],
  ['Not Acceptable: Client must accept both application/json and text/event-stream', 'not_acceptable'],
  ['Unsupported Media Type: Content-Type must be application/json', 'content_type'],
])

/** Inspect only the host's already-constructed small JSON string, never consume
 * a Request stream or retain tool arguments. */
function rpcMethodOf(options) {
  if (typeof options?.body !== 'string' || Buffer.byteLength(options.body) > 4096) return 'OTHER'
  try { const method = JSON.parse(options.body)?.method; return rpcMethods.has(method) ? method : 'OTHER' }
  catch { return 'OTHER' }
}

/** A failed response's clone is bounded in bytes and time. Cancellation of a
 * tee can wait for its other branch, so never await that diagnostic cleanup. */
async function rpcFailureOf(response) {
  let reader, timer
  try {
    reader = response.clone().body?.getReader()
    if (!reader) return { rpcErrorClass: 'body_unavailable' }
    const read = async () => {
      const chunks = []; let size = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 4096) return { rpcErrorClass: 'body_limit' }
        chunks.push(value)
      }
      let packet
      try { packet = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch { return { rpcErrorClass: 'invalid_json' } }
      const error = packet?.jsonrpc === '2.0' && packet.error && typeof packet.error === 'object' ? packet.error : undefined
      const category = rpcErrors.get(error?.message)
        ?? (typeof error?.message === 'string' && error.message.startsWith('Bad Request: Unsupported protocol version: ') ? 'protocol_version' : 'other')
      return { ...(rpcCodes.has(error?.code) ? { rpcErrorCode: error.code } : {}), rpcErrorClass: category }
    }
    return await Promise.race([read(), new Promise(resolve => { timer = setTimeout(() => resolve({ rpcErrorClass: 'body_deadline' }), 250) })])
  } catch { return { rpcErrorClass: 'body_unavailable' } }
  finally { clearTimeout(timer); void reader?.cancel().catch(() => undefined) }
}

/** Observe the exact real mailbox transport without consuming or changing its
 * request/response, signal, timeout or error. Successful bodies are untouched;
 * a failed JSON response is inspected on a bounded clone without awaiting it
 * before returning. Output contains closed metadata, never message/body text. */
export function observeTraceMcpFetch(fetcher, sink = value => console.info(JSON.stringify({ traceFixtureHttp: value }))) {
  let remaining = 64
  const names = new Set(['Error', 'TypeError', 'AbortError', 'TimeoutError', 'DOMException'])
  const errors = new Set(['ABORT_ERR', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET'])
  return async (input, options) => {
    let url
    try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url) }
    catch { return fetcher(input, options) }
    if (url.origin !== 'http://localhost:3100' || url.pathname !== '/mikka/api/mcp' || remaining <= 0) return fetcher(input, options)
    remaining--
    const requested = options?.method ?? (input instanceof Request ? input.method : 'GET')
    const method = ['GET', 'POST', 'DELETE'].includes(requested) ? requested : 'OTHER'
    const rpcMethod = rpcMethodOf(options)
    const started = Date.now()
    const report = (fields, durationMs = Date.now() - started) => { try { sink({ route: 'mcp', method, rpcMethod, durationMs, ...fields }) } catch { /* Preserve transport behavior. */ } }
    try {
      const response = await fetcher(input, options)
      const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
      const responseType = ['application/json', 'text/event-stream', 'text/plain', 'text/html'].includes(type) ? type : type ? 'OTHER' : 'NONE'
      const fields = { status: response.status, responseType }, durationMs = Date.now() - started
      if (!response.ok && responseType === 'application/json') {
        void rpcFailureOf(response).then(failure => report({ ...fields, ...failure }, durationMs), () => report(fields, durationMs))
      } else report(fields, durationMs)
      return response
    } catch (error) {
      report({ errorName: names.has(error?.name) ? error.name : 'Error', ...(errors.has(error?.code) ? { code: error.code } : {}) })
      throw error
    }
  }
}

/** Error projection at the scripted-model boundary: exact enumerated tool
 * refusals survive; arbitrary tool output never becomes an error message. */
export function fixtureModelError(code, operation, result) {
  return Object.assign(new Error(codes.has(code) ? code : 'MODEL_RESULT_REFUSED'), {
    code: codes.has(code) ? code : 'MODEL_RESULT_REFUSED',
    ...(operations.has(operation) ? { fixtureOperation: operation } : {}),
    ...(codes.has(result?.error) ? { sourceCode: result.error } : {}),
    ...(reasons.has(result?.reason) ? { sourceReason: result.reason } : {}),
  })
}
