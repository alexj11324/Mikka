import { createHash } from 'node:crypto'

const uuid = value => typeof value === 'string' && /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value)
const digest = value => createHash('sha256').update(value).digest('hex')
const check = (condition, code) => { if (!condition) throw new Error(`issue1503_${code}`) }

/** NewTaskDialog -> useCoordinatorSubmit: the task form supplies the structured
 * destination. Only the real Coordinator's create_issue binds its source event. */
export function explicitNewTaskArguments(text, botId, submissionId, profileId) {
  return [text, undefined, botId, submissionId, { kind: 'cloud' }, undefined, undefined, undefined, profileId]
}

function replyItems(chat, text, after) {
  if (chat?.working !== false || !Array.isArray(chat.items)) return null
  const person = chat.items.find(item => item.from === 'person' && item.position > after && item.text === text && !item.pending && uuid(item.id))
  if (!person) return null
  const replies = chat.items.filter(item => item.from === 'coordinator' && item.position > person.position && !item.pending && uuid(item.id))
  return replies.length ? { person, replies } : null
}

/** A queued/inferred person row or a live stream is not a committed reply. */
export function explicitNewTaskComplete(chat, text, after) {
  return replyItems(chat, text, after) !== null
}

// Normal chat previews intentionally stop at 200 characters and may not be
// complete JSON. The short id/runId fields survive that projection; do not
// invent the missing tail or treat a prose UUID as a tool receipt.
function previewId(text, field) {
  if (typeof text !== 'string') return null
  const found = text.match(new RegExp(`(?:^|[,{]\\s*)"${field}"\\s*:\\s*"([a-f\\d-]{36})"`, 'i'))?.[1]
  return uuid(found) ? found.toLowerCase() : null
}

/** Cleanup may need successful tool receipts before the Coordinator finishes
 * its turn, or after a later tool fails. These IDs do not establish acceptance.
 * The caller separately binds this chat to the invocation's newly created bot. */
export function explicitNewTaskCleanupReceipts(chat, text, after) {
  const empty = { issueIds: [], runIds: [] }
  if (!Array.isArray(chat?.items)) return empty
  const people = chat.items.filter(item => item.from === 'person' && item.position > after)
  const person = people[0]
  if (people.length !== 1 || person.text !== text || person.pending || !uuid(person.id)) return empty
  const tools = chat.items.filter(item => item.from === 'coordinator' && item.position > person.position && !item.pending && uuid(item.id))
    .flatMap(item => item.activity?.tools ?? [])
  const ids = (name, field) => [...new Set(tools.filter(item => item.name === name && item.state === 'done')
    .map(item => previewId(item.output, field)).filter(uuid))]
  return { issueIds: ids('create_issue', 'id'), runIds: ids('dispatch_run', 'runId') }
}

export function explicitNewTaskEvidence(chat, text, after, issueId) {
  const reply = replyItems(chat, text, after)
  check(reply && uuid(issueId) && !chat.error, 'new_task_reply_missing')
  check(chat.items.filter(item => item.from === 'person' && item.position > after).length === 1, 'new_task_concurrent_message')
  const tools = reply.replies.flatMap(item => item.activity?.tools ?? [])
  const creates = tools.filter(item => item.name === 'create_issue' && item.state === 'done' && previewId(item.output, 'id'))
  check(creates.length > 0 && creates.every(item => previewId(item.output, 'id') === issueId), 'new_task_creation_receipt_missing')
  const dispatches = tools.filter(item => item.name === 'dispatch_run' && item.state === 'done' && previewId(item.output, 'runId'))
  const runIds = [...new Set(dispatches.map(item => previewId(item.output, 'runId')))]
  const displayedRuns = new Set(reply.replies.flatMap(item => item.threads ?? []))
  check(runIds.length === 1 && displayedRuns.has(runIds[0]), 'new_task_dispatch_receipt_missing')
  return { source: 'normal_new_task_dialog_rpc', personMessageId: reply.person.id, personPosition: reply.person.position,
    taskDestination: { kind: 'cloud' }, runId: runIds[0],
    create: creates.map(item => ({ toolCallId: item.call, outputSha256: digest(item.output) })),
    dispatch: dispatches.map(item => ({ toolCallId: item.call, outputSha256: digest(item.output) })) }
}
