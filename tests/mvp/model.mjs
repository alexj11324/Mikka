// A scripted model, not a replacement for the Coordinator. WorkflowAgent still
// executes the real registered tools, durable steps and authorization checks.
function result(content, reason = 'stop') {
  return { content, finishReason: { unified: reason, raw: reason }, warnings: [], usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } }
}

const text = value => result([{ type: 'text', text: value }])
const body = message => typeof message.content === 'string' ? message.content : (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')

function output(messages, toolName) {
  const part = messages.flatMap(message => Array.isArray(message.content) ? message.content : []).findLast(part => part.type === 'tool-result' && part.toolName === toolName)
  if (!part) return undefined
  if (part.output?.type !== 'json' || part.output.value?.error) throw new Error(`Real ${toolName} returned a failed or non-JSON result`)
  return part.output.value
}

export function answerModel(request, scenario, observe = () => {}) {
  const prompt = request.prompt ?? []
  const start = scenario ? prompt.findLastIndex(message => message.role === 'user' && body(message).includes(scenario.marker)) : -1
  if (start < 0) return text('你想先做哪件事？')
  const messages = prompt.slice(start)
  const selected = body(prompt[start]).match(/The person selected device ([a-f0-9-]{36}) in the task dialog\./)?.[1]
  if (!scenario.deviceId || selected !== scenario.deviceId) throw new Error('The host-supplied task destination did not select the real daemon device')
  observe({ kind: 'destination', deviceId: selected })
  const call = (toolName, input, phase = 'dispatch') => {
    if (!request.tools?.some(tool => tool.name === toolName)) throw new Error(`Coordinator did not register ${toolName}`)
    const toolCallId = `${scenario.marker}-${phase}-${toolName}`
    observe({ kind: 'tool', toolName, toolCallId, input })
    return result([{ type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) }], 'tool-calls')
  }
  const ended = messages.findLastIndex(message => message.role === 'user' && /\[Event\] Run [a-f0-9-]{36} ended/.test(body(message)))
  if (ended >= 0) {
    const event = body(messages[ended])
    const runId = event.match(/\[Event\] Run ([a-f0-9-]{36}) ended/)?.[1]
    const recent = messages.slice(ended)
    const run = output(recent, 'get_run')
    if (!run) return call('get_run', { runId }, 'result')
    if (run.status !== 'succeeded') return text('线程已停止。')
    const task = output(recent, 'get_issue')
    if (!task) return call('get_issue', { issueId: run.issueId }, 'result')
    const url = event.match(/https:\/\/github\.com\/mikka-e2e\/core-loop\/pull\/\d+/)?.[0]
    if (!url || task.id !== run.issueId || !run.summary) throw new Error('Completion reached the model without the real task, summary or PR receipt')
    observe({ kind: 'result', runId, issueId: task.id, pullRequest: url })
    return text(`已完成：${run.summary}\n\nPR：${url}`)
  }
  const issue = output(messages, 'create_issue')
  if (!issue) return call('create_issue', { title: scenario.title, body: `Add MIKKA_MOCK.md to ${scenario.repo}. ${scenario.marker}` })
  const identities = output(messages, 'list_agents')
  if (!identities) return call('list_agents', {})
  const identity = identities.find(row => row.deviceId === selected && row.harness === 'mock' && row.deviceOnline)
  if (!identity) throw new Error('The real daemon did not register an online mock execution identity')
  const run = output(messages, 'dispatch_run')
  if (!run) return call('dispatch_run', { issueId: issue.id, agentId: identity.id, repo: scenario.repo })
  if (!run.runId) throw new Error('Real dispatch_run did not queue a thread')
  observe({ kind: 'dispatched', issueId: issue.id, runId: run.runId, deviceId: selected })
  return text('已在你选择的电脑上启动线程。')
}
