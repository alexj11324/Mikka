// Deterministic local-loop model choices. Tools still execute in the real product.
import { randomUUID } from 'node:crypto'

const uuid = '[a-f0-9-]{36}'
export const textOf = message => typeof message?.content === 'string' ? message.content
  : (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
export const reply = text => ({ content: [{ type: 'text', text }], finishReason: 'stop' })
export function unbox(value) {
  for (let i = 0; i < 6; i++) {
    if (typeof value === 'string') { try { value = JSON.parse(value); continue } catch { return value } }
    if (value?.type === 'json' || value?.type === 'text') { value = value.value; continue }
    if (Array.isArray(value?.content) && value.content.every(part => part.type === 'text')) { value = value.content.map(part => part.text).join('\n'); continue }
    return value
  }
  return value
}
export function scriptContext(request) {
  const prompt = request.prompt ?? []
  const latest = prompt.findLastIndex(message => message.role === 'user')
  const records = messages => messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'tool-result')
  const hasName = (actual, expected) => actual === expected || actual?.endsWith(`__${expected}`)
  const tools = request.tools ?? []
  return {
    prompt, user: textOf(prompt[latest]), all: prompt.map(textOf).join('\n'),
    has: name => tools.some(tool => hasName(tool.name, name)),
    results: (name, all = false) => records(all ? prompt : prompt.slice(latest)).filter(part => hasName(part.toolName, name)).map(part => unbox(part.output)),
    call(name, input) {
      const found = tools.find(tool => hasName(tool.name, name))
      if (!found) return { status: 422, code: 'fixture_registered_tool_missing' }
      return { content: [{ type: 'tool-call', toolCallId: `local-${randomUUID()}`, toolName: found.name, input: JSON.stringify(input) }], finishReason: 'tool-calls' }
    },
  }
}

function structuredGroup(c) {
  let value
  try { value = JSON.parse(c.user) } catch { return null }
  if (!value.message?.text?.includes('这是两位Agent互相传话的验收')) return null
  const marker = value.message.text.match(new RegExp(`交接 (${uuid})`))?.[1]
  const receiver = value.currentMembers?.find(member => member.name?.startsWith('Receiver '))
  const sender = value.currentMembers?.find(member => member.name?.startsWith('Sender '))
  if (!marker || !receiver || !sender) return null
  const isReceiver = c.prompt.some(message => message.role === 'system' && textOf(message).startsWith(`You are ${receiver.name}.`))
  if (isReceiver) {
    if (!JSON.stringify(value.earlierReplies).includes(`交接 ${marker}`)) return { status: 422, code: 'fixture_group_handoff_not_observed' }
    return reply(JSON.stringify({ text: `收到 ${marker}`, mentions: [], privateTo: null }))
  }
  return reply(JSON.stringify({ text: `交接 ${marker}`, mentions: [receiver.id], privateTo: null }))
}

function coordinator(c) {
  if (!c.has('create_issue')) return null
  const start = c.prompt.findLastIndex(message => message.role === 'user' && /验收标记：|Personal mailbox notification acceptance worker-mailbox-|Inbox [a-f0-9-]{36}/.test(textOf(message)))
  if (start < 0) return null
  const original = textOf(c.prompt[start])
  const task = /验收标记：([^\s]+)/.exec(original)?.[1] ?? /worker-mailbox-[a-f0-9-]{36}/.exec(original)?.[0]
  const ended = c.user.match(new RegExp(`Run (${uuid}) ended`))
  if (ended) {
    const run = c.results('get_run').at(-1)
    if (!run) return c.call('get_run', { runId: ended[1] })
    if (run.id !== ended[1]) return { status: 422, code: 'fixture_run_receipt_mismatch' }
    const url = c.user.match(/https:\/\/github\.com\/mikka-e2e\/core-loop\/pull\/\d+/)?.[0]
    return reply(`${run.status}: ${run.summary ?? run.error ?? ''}${url ? `\nPR: ${url}` : ''}`)
  }
  const recent = scriptContext({ prompt: c.prompt.slice(start), tools: [] })
  const issue = recent.results('create_issue', true).at(-1)
  if (!issue) return c.call('create_issue', { title: /Inbox [a-f0-9-]{36}/.exec(original)?.[0] ?? `Local acceptance ${task}`, body: original })
  if (!issue.id || issue.error) return { status: 422, code: 'fixture_issue_not_created' }
  if (!task) return reply(`Created ${issue.id}`)
  const selected = original.match(new RegExp(`(?:设备ID |deviceId )(${uuid})`))?.[1]
  if (!selected) return { status: 422, code: 'fixture_device_not_selected' }
  const identities = recent.results('list_agents', true).at(-1)
  if (!identities) return c.call('list_agents', {})
  const identity = identities.find(row => row.deviceId === selected && row.harness === 'claude_code' && row.deviceOnline)
  if (!identity) return { status: 422, code: 'fixture_identity_not_available' }
  const run = recent.results('dispatch_run', true).at(-1)
  if (!run) return c.call('dispatch_run', { issueId: issue.id, agentId: identity.id, target: { deviceId: selected }, model: { harness: 'claude_code' }, repo: 'https://github.com/mikka-e2e/core-loop.git', note: original, readOnly: /readOnly:true/.test(original), newThread: true })
  if (!run.runId || run.error) return { status: 422, code: 'fixture_run_not_queued' }
  return reply(`已在所选电脑启动线程 ${run.runId}。`)
}

function mailbox(c) {
  if (!c.has('mailbox_recipients')) return null
  if (/Call mailbox_recipients exactly once/.test(c.user) && /initialize/.test(c.user)) {
    const address = c.results('mailbox_recipients').at(-1)
    return address ? reply(JSON.stringify(address)) : c.call('mailbox_recipients', {})
  }
  const explicit = c.user.match(/\{[^{}]*"to"\s*:[^{}]*\}/)?.[0]
  if (explicit && /Mailbox retry acceptance|new owned worker mailbox|isolation probe/.test(c.user)) {
    const input = JSON.parse(explicit)
    if (!/isolation probe/.test(c.user) && !c.results('mailbox_recipients').length) return c.call('mailbox_recipients', {})
    const sends = c.results('mailbox_send')
    if (sends.length < (/Mailbox retry acceptance/.test(c.user) ? 2 : 1)) return c.call('mailbox_send', input)
    if (/isolation probe/.test(c.user)) return reply(JSON.stringify(sends))
    if (!c.results('mailbox_sent').length) return c.call('mailbox_sent', {})
    return reply(JSON.stringify(c.results('mailbox_sent').at(-1)))
  }
  // Bot wakes use the product's peer envelope, while native worker notices use
  // runtime_notification. Neither contains the mail: read its actual inbox next.
  const peerNotice = c.user.split('\n').some(line => {
    const prefix = '[Event] An Agent reports coordination data: '
    if (!line.startsWith(prefix)) return false
    try {
      const packet = JSON.parse(line.slice(prefix.length))
      return packet.version === 1 && packet.kind === 'personal_agent_message'
        && packet.authority === 'coordination_data_only' && packet.source?.origin === 'peer_agent'
        && packet.untrustedData?.body?.startsWith('A new personal mailbox message is waiting. Read mailbox_inbox')
    } catch { return false }
  })
  if (!peerNotice && (!/runtime_notification/.test(c.user) || !/mailbox/i.test(c.user))) return null
  const inbox = c.results('mailbox_inbox').at(-1)
  if (!inbox) return c.call('mailbox_inbox', {})
  if (!Array.isArray(inbox.messages)) return { status: 422, code: 'fixture_mailbox_receipt_missing' }
  const marker = /REQUEST ((?:worker-)?mailbox-[a-f0-9-]{36})/.exec(c.all)?.[1]
  const key = new RegExp(`key[= ]+(${uuid})`).exec(c.all)?.[1]
  const incoming = inbox.messages.find(message => marker && message.text.includes(`REQUEST ${marker}`))
  if (incoming && key && !c.results('mailbox_send').length) return c.call('mailbox_send', { to: incoming.senderMailboxId, key, text: `REPLY ${marker}`, replyTo: incoming.id })
  if (!c.results('mailbox_ack').length) return c.call('mailbox_ack', { ids: inbox.messages.filter(message => !message.acknowledgedAt).map(message => message.id) })
  if (!c.results('mailbox_sent').length) return c.call('mailbox_sent', {})
  return c.has('submit') ? null : reply('Mailbox handling completed from actual inbox and ACK receipts.')
}

export function localLoopModelAnswer(request) {
  const c = scriptContext(request)
  return structuredGroup(c) ?? coordinator(c) ?? mailbox(c)
}

export function localGroupDecision(input) {
  const encoded = typeof input.input === 'string' ? input.input : JSON.stringify(input.input)
  if (!encoded.includes('这是两位Agent互相传话的验收')) return null
  const answers = input.questions?.map(question => {
    const choices = question.choices?.map(choice => choice.value) ?? []
    const choice = question.name === 'intent' ? 'reply_useful_answer'
      : question.name === 'contribution' ? 'contribute'
      : question.name.startsWith('responder_') ? choices.find(value => new RegExp(`^${uuid}$`).test(value)) : null
    return choice && choices.includes(choice) ? { type: 'choice', name: question.name, choice } : null
  })
  return answers?.length && answers.every(Boolean) ? { model: input.model, answers } : null
}
