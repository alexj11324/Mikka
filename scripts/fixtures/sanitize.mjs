import { createHash } from 'node:crypto'
import { PROVIDER_FAILURE_CODES } from '../../packages/protocol/src/provider-failure.ts'

const sensitiveKey = /authorization|cookie|password|secret|token$|api[_-]?key|credential/i
const identities = /^(id|\w+Id|call_id|key|parentKey|blockedBy)$/
const protocolValues = new Set(['succeeded', 'failed', 'cancelled', 'submitted', 'turn_ended', 'asked_human', 'blocked', 'error', 'timeout', 'device_lost', 'quota_exhausted', 'provider_failure', 'stop', 'length', 'tool-calls', 'content-filter', 'unknown', 'other', 'added', 'modified', 'deleted', 'passed', 'unverified', 'changes_requested', 'needs_judgment', 'repository', 'worktree', 'agent_start', 'read_only', 'low', 'medium', 'high', 'urgent', 'small', 'large', 'claude_code', 'codex', 'anthropic', 'openai', 'rate_limited', 'unavailable', 'context_window_exceeded', 'authentication', 'quota', 'text', 'json'])
for (const value of ['none', 'no_changes', 'not_approved', 'working', 'queued', 'preparing', 'running', 'stopped', 'balance', 'auth', 'model', 'context', 'decision', 'permission', 'external', 'verification_command', ...PROVIDER_FAILURE_CODES]) protocolValues.add(value)
const safeLiteralKeys = new Set(['outcome', 'stopReason', 'finishReason', 'change', 'status', 'state', 'stage', 'skipped', 'reviewVerdict', 'priority', 'size', 'harness', 'provider', 'kind', 'purpose', 'code'])
const payloadKeys = new Set(['input', 'output', 'providerMetadata', 'metadata', 'request', 'response', 'headers'])
// Property names may themselves contain a private path or user text. Preserve
// only published protocol field names; all other names are anonymous too.
const protocolKeys = new Set(`t chunk submit exit type id messageId toolCallId toolName input output providerMetadata metadata request response headers delta text error errorText outcome stopReason report sessionExited quota resetsAt providerFailure kind retryable status code sourceId url title mediaType filename data transient approvalId providerExecuted dynamic toolDurationMs summary openQuestions nextStep blockedOn plan specId spec sections heading items split issues key parentKey blockedBy goal criteria body checkCommand verifyCommand predictedFiles sizeEstimate files lines priority criterionId passed reason resolution evidence command exitCode question questionId purpose context options verificationCommand basis repositorySelection repository observedRemote observedHead reviewVerdict previewDatabaseBranch visualEvidence captureId publicSafe path change inputTokens outputTokens costUsd source branch commit pushed remote skipped note state stage ms ok botId runId task finishReason messageMetadata`.split(' '))
const patterns = [
  ['provider_key', /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/],
  ['bearer', /\bBearer\s+(?!\[redacted:)[A-Za-z0-9_.~+/-]{8,}/i],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['email', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ['private_path', /(?:\/(?:Users|home|workspace|private|root)\/[^\s"<>]+|[A-Z]:\\(?:Users|repos)\\)/],
]

/** Return only locations and categories; never echo a suspected secret. */
export function scanSensitive(value) {
  const findings = []
  const visit = (node, location = '$', key = '') => {
    if (typeof node === 'string') {
      if (sensitiveKey.test(key) && !/^\[redacted:credential\]$/.test(node)) findings.push({ location, category: 'credential_field' })
      for (const [category, pattern] of patterns) if (pattern.test(node)) findings.push({ location, category })
    } else if (Array.isArray(node)) node.forEach((child, index) => visit(child, `${location}[${index}]`, key))
    else if (node && typeof node === 'object') for (const [index, [name, child]] of Object.entries(node).entries()) {
      for (const [category, pattern] of patterns) if (pattern.test(name)) findings.push({ location: `${location}[${index}]`, category })
      visit(child, `${location}[${index}]`, name)
    }
  }
  visit(value)
  return findings
}

/** Drop every free-text value, not just known key patterns. Preserve correlation
 * with stable anonymous IDs and protocol values needed by the current adapter. */
export function sanitizeRecording(value) {
  const ids = new Map(), tools = new Map(), fields = new Map()
  const anonymous = input => {
    if (!ids.has(input)) ids.set(input, `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, '0')}`)
    return ids.get(input)
  }
  const visit = (node, key = '') => {
    if (sensitiveKey.test(key)) return '[redacted:credential]'
    if (key === 'providerMetadata') return { recorded: { redacted: true } }
    if (payloadKeys.has(key)) return '[redacted:payload]'
    if (Array.isArray(node)) return node.map(child => visit(child, key))
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([name, child]) => {
      if (!protocolKeys.has(name) && !fields.has(name)) fields.set(name, `redacted_field_${fields.size + 1}`)
      return [protocolKeys.has(name) ? name : fields.get(name), visit(child, name)]
    }))
    if (typeof node !== 'string') return node
    if (identities.test(key)) return anonymous(node)
    if (key === 'type' && /^[a-z][a-z0-9-]{0,80}$/.test(node)) return node
    if (safeLiteralKeys.has(key) && protocolValues.has(node)) return node
    if (key === 'toolName') { if (!tools.has(node)) tools.set(node, `recorded_tool_${tools.size + 1}`); return tools.get(node) }
    if (key === 'observedHead' && /^[a-f0-9]{40}$/.test(node)) return sha256(node).slice(0, 40)
    if (key === 'resetsAt' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(node)) return node
    if (key === 'path') return 'fixture-files/redacted.txt'
    return '[redacted:text]'
  }
  const sanitized = visit(value)
  if (scanSensitive(sanitized).length) throw new Error('fixture_sanitization_failed')
  return sanitized
}

export const sha256 = value => createHash('sha256').update(value).digest('hex')
