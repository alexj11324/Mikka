// Closed metadata for the isolated fixture report. No message, response, URL,
// argument, function name, absolute path or raw stack belongs in this output.
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACTION_ERROR_CODES } from '../../lib/action-result.ts'

const handlers = new Set(['route', 'extension', 'health', 'observations', 'streaming_scenario', 'streaming_control',
  'scenario', 'scenario_device', 'subscription_model', 'subscription_prompt', 'subscription_answer', 'subscription_chunks',
  'language_model', 'decisions', 'decisions_push', 'decisions_outcome', 'decisions_tier', 'github'])
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
const operations = new Set(['create_issue', 'list_agents', 'dispatch_run', 'get_run', 'get_issue',
  'prepare', 'models', 'usage', 'quota', 'nativeContext', 'nativeAuth', 'executeStream'])
const names = new Set(['Error', 'TypeError', 'SyntaxError', 'RangeError', 'AssertionError', 'AbortError', 'AggregateError', 'ActionFailureError', 'WorkerRefusal'])
const codes = new Set([...ACTION_ERROR_CODES, 'ERR_ASSERTION', 'ERR_MODULE_NOT_FOUND', 'ERR_INVALID_ARG_TYPE', 'ENOENT', 'EACCES',
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ABORT_ERR', 'subscription_fixture_refused',
  'githubReconnectRequired', 'repositoryRequired', 'machineUnavailable', 'modelNotAllowed', 'factoryLifecycleUnavailable',
  'agentProfileUnavailable', 'agentProfilePinConflict', 'MODEL_RESULT_REFUSED', 'MODEL_TOOL_MISSING',
  'MODEL_DESTINATION_MISMATCH', 'MODEL_IDENTITY_MISSING', 'MODEL_RUN_NOT_QUEUED', 'MODEL_COMPLETION_MISMATCH'])
const reasons = new Set(['noModels', 'cloudNotConfigured', 'cloudModelsUnknown', 'cloudModelNotReported', 'noDevice', 'checking', 'unavailable'])
const sources = new Set(['diagnostics.mjs', 'services.mjs', 'model.mjs', 'subscription.mjs', 'subscription-worker.mjs',
  'trace-chain.mjs', 'trace-codex.mjs', 'fixture.test.mjs'])
const escapedDirectory = dirname(fileURLToPath(import.meta.url)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const frame = new RegExp(`(?:file:\\/\\/)?${escapedDirectory}/([a-z0-9.-]+\\.mjs):([0-9]{1,5}):([0-9]{1,5})(?:\\)|$)`)

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
  return {
    handler: handlers.has(handler) ? handler : 'route',
    method: methods.has(method) ? method : 'OTHER',
    name: names.has(error?.name) ? error.name : 'Error',
    ...(codes.has(error?.code) ? { code: error.code } : {}),
    ...(operations.has(error?.fixtureOperation) ? { operation: error.fixtureOperation } : {}),
    ...(codes.has(error?.sourceCode) ? { sourceCode: error.sourceCode } : {}),
    ...(reasons.has(error?.sourceReason) ? { sourceReason: error.sourceReason } : {}),
    source,
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
