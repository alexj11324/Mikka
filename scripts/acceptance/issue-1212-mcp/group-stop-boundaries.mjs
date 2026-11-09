// Reuse the existing group Stop evidence boundaries; no account or network.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const fail = code => { throw Error(code) }
export function stateMetadata(value, botIds) {
  if (!Array.isArray(value?.messages) || value.messages.length > 100 || value.agentStatus !== null &&
    (!value.agentStatus || !['queued', 'running'].includes(value.agentStatus.status))) fail('group_state_invalid')
  if (value.agentStatus?.agentId || value.agentStatus?.botId && !botIds.includes(value.agentStatus.botId)) fail('group_scope_mismatch')
  return { revision: Number.isSafeInteger(value.revision) && value.revision > 0 ? value.revision : 0,
    active: value.agentStatus !== null, status: value.agentStatus ? value.agentStatus.status : 'idle',
    respondingBotId: value.agentStatus?.botId ?? null, stopped: value.stopped === true,
    messageCount: value.messages.length, botReplyCount: value.messages.filter(message => message.authorType === 'bot').length }
}

export function privateExchange(value, root, botIds) {
  const links = Array.isArray(value?.timeline) ? value.timeline.filter(item => item.type === 'agent_exchange' &&
    String(item.anchorPosition) === String(root.position)) : []
  if (links.length !== 1) return null
  const link = links[0], participants = link.participants
  if (!UUID.test(link.linkId ?? '') || Number(link.count) !== 1 || !Array.isArray(participants) || participants.length !== 2 ||
    participants.some(item => item.memberType !== 'bot' || !botIds.includes(item.id)) ||
    new Set(participants.map(item => item.id)).size !== 2) return null
  return { linkId: link.linkId, privateMessagesBeforeStop: 1 }
}

export function privateGenerationReceipt(trace, messageId, leadBotId, targetBotId) {
  const turn = Array.isArray(trace?.turns) ? trace.turns.find(row => row.messageId === messageId) : null
  const events = Array.isArray(turn?.trace?.events) ? turn.trace.events : []
  const publishAt = events.findIndex(row => row.type === 'private_publish' && row.memberId === leadBotId)
  const targetAt = events.findIndex((row, index) => index > publishAt && row.type === 'generate' && row.memberId === targetBotId)
  if (!turn || turn.status !== 'running' || turn.error || turn.trace?.status !== 'pending' || publishAt < 0 || targetAt <= publishAt ||
    events.filter(row => row.type === 'private_publish').length !== 1 ||
    events.some(row => ['publish', 'delegate'].includes(row.type)) ||
    events.slice(targetAt + 1).some(row => ['generate', 'silent', 'private_publish', 'publish'].includes(row.type))) fail('group_private_generation_not_observed')
  return { privatePublishes: 1, publicPublishes: 0, targetGenerateRecorded: true, targetBotId,
    boundary: 'host_private_generate_receipt', providerInFlight: 'requires_start_end_log_correlation' }
}
