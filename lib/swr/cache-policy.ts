/** Only ordinary read models belong on disk. Credential, approval, subscription,
 * billing and session endpoints are deliberately absent from this allowlist. */
const scalarKeys = new Set(['coordinator-chat', 'preferences', 'settings:issue-prefix', '/api/workspace/switcher'])
const tupleKeys = new Set(['issues', 'threads', 'issue', 'issue-activity-versions', 'bots', 'bot-chats', 'bot-list-groups', 'coordinator-chat', 'team-directory', 'team-members', 'workspace:general'])

export function persistentReadKey(key: unknown): boolean {
  if (typeof key === 'string') return scalarKeys.has(key) || /^\/api\/workspace(?:\?workspace=[^&]+)?$/.test(key)
  return Array.isArray(key) && key.length >= 2 && key.length <= 3 && key.every(part => part === null || typeof part === 'string') && typeof key[0] === 'string' && (tupleKeys.has(key[0]) || /^\/api\/workspace(?:\?workspace=[^&]+)?$/.test(key[0]))
}

// Read models can acquire new fields. The key allowlist is the first boundary;
// this second boundary keeps nested tool parameters and credential-like fields
// out of an otherwise permitted model, including task document attributes.
const privateField = /(?:secret|password|credential|authorization|cookie|key|token|connection[_-]?string)|^(?:headers|env|environment|input|output|arguments|parameters|params|approvals?|requestedAt)$/i
const secretText = /(?:\b(?:sk|ghp|gho|github_pat|dckr_pat|phx|xox[baprs])[-_][A-Za-z0-9_-]{16,}|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/i
const credentialUrl = /[?&](?:token|key|secret|password|signature|credential|x-amz-signature|x-amz-credential)=|\b[a-z][a-z+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i

// Task attrs are extensible JSON, so a new integration payload must not become
// durable by accident. These are the editor/schema and public task metadata.
const documentAttrs = new Set(['mikka', 'orvilo', 'textAlign', 'id', 'label', 'mentionSuggestionChar', 'language', 'level', 'start', 'type', 'checked', 'colspan', 'rowspan', 'colwidth', 'align', 'href', 'target', 'rel', 'class', 'title', 'color', 'author', 'time'])
const issueMetadata = new Set(['number', 'assignee', 'project', 'labels', 'pullRequests', 'parentId', 'blockedByIds', 'relatedIds', 'duplicateOfId', 'dueDate', 'estimate', 'favoriteUserIds', 'subscriberUserIds', 'deletedAt'])
const activityFields = new Set(['tools', 'thought', 'reasoningAt'])
const toolFields = new Set(['call', 'name', 'state', 'at'])
const toolMetadataFields = new Set(['target', 'displayName', 'errorCode', 'errorDetail'])
type Projection = { sensitive: boolean; changed: boolean; needsChatMetadataRefresh: boolean; issue: boolean; chat: boolean; issuePrefix: boolean }

/** Return plain structured data only; never serialize SWR errors or functions. */
function clean(value: unknown, context: Projection, depth = 0, allowed?: ReadonlySet<string>): unknown {
  if (depth > 40) { context.sensitive = true; return undefined }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') {
    if (secretText.test(value) || credentialUrl.test(value)) context.sensitive = true
    return value
  }
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(item => clean(item, context, depth + 1, allowed)).filter(item => item !== undefined)
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    if (value !== undefined) context.sensitive = true
    return undefined
  }
  const result: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(value)) {
    // The one-time network overlay is not an ordinary read model. Its dynamic
    // labels must never bypass activity.tools' allowlist via a root field.
    if (context.chat && depth === 0 && key === 'toolMetadata') {
      if (field !== undefined) context.needsChatMetadataRefresh = true
      continue
    }
    // This read returns public Linear team identifiers, not credential keys.
    // Keep the exception at its exact root field; each string still gets scanned.
    const publicTeamKeys = context.issuePrefix && depth === 0 && key === 'teamKeys' && Array.isArray(field) && field.every(item => typeof item === 'string')
    if (!publicTeamKeys && privateField.test(key) || allowed && !allowed.has(key)) {
      // requestedAt is a page-local monotonic clock, never a server proof.
      if (key !== 'requestedAt' && field !== undefined) context.changed = true
      if (allowed === toolFields && toolMetadataFields.has(key) && field !== undefined) context.needsChatMetadataRefresh = true
      continue
    }
    const fields = context.issue && key === 'attrs' ? documentAttrs
      : context.issue && ['metadata', 'mikka', 'orvilo'].includes(key) ? issueMetadata
        : context.chat && key === 'activity' ? activityFields
          : allowed === activityFields && key === 'tools' ? toolFields : undefined
    const next = clean(field, context, depth + 1, fields)
    if (next !== undefined) result[key] = next
  }
  return result
}

export function persistentReadData(key: unknown, data: unknown): unknown {
  if (!persistentReadKey(key) || data === undefined) return undefined
  const family = Array.isArray(key) ? key[0] : key
  const context: Projection = { sensitive: false, changed: false, needsChatMetadataRefresh: false, issue: ['issue', 'issues', 'issue-activity-versions'].includes(family), chat: family === 'coordinator-chat', issuePrefix: key === 'settings:issue-prefix' }
  let projected = data
  if (family === 'coordinator-chat' && data && typeof data === 'object' && 'items' in data && Array.isArray(data.items)) {
    // The existing continuation proves the server's latest 200-message window.
    // Older pages and optimistic/inbox messages have no such proof after reload.
    const cursor = 'cursor' in data && typeof data.cursor === 'number' ? data.cursor : 0
    const eligible = data.items.filter(item => item && typeof item === 'object' && !item.pending && Number.isInteger(item.position) && item.position >= 0)
    const items = eligible.filter(item => item.position >= Math.max(0, cursor - 199)).slice(-200)
    const first = items[0]?.position
    const retained = new Set(items)
    // Preserve the server's edge unless persistence actually drops older rows.
    const discardedEarlier = first !== undefined && eligible.some(item => !retained.has(item) && item.position < first)
    const { streamRunId: _stream, ...rest } = data as Record<string, unknown>
    projected = { ...rest, items, working: false, ...(discardedEarlier ? { historyBefore: first } : {}) }
  }
  const value = clean(projected, context)
  // Required text fields must retain their shape. If a value itself looks like
  // a credential, skip the entire record instead of persisting a broken model.
  // A task's readVersion and list row proofs cover the original payload. Never
  // restore an altered document as verified/writable. Chat is the sole projected
  // exception: a bounded preview remains useful. New visible tool metadata
  // still derives from parameters and cannot go to disk. Repair snapshots that
  // lost those labels once on startup; a tail replay cannot restore the prefix.
  // Existing input/output/quote redaction alone keeps its incremental cursor.
  if (context.sensitive || context.changed && !context.chat) return undefined
  if (context.chat && context.needsChatMetadataRefresh && value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...value, restoreToolMetadata: true }
  }
  return value
}
