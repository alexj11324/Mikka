// A scripted model, not a replacement for the Coordinator. WorkflowAgent still
// executes the real registered tools, durable steps and authorization checks.
import { fixtureModelError } from './diagnostics.mjs'
function result(content, reason = 'stop') {
  return { content, finishReason: { unified: reason, raw: reason }, warnings: [], usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } }
}

const text = value => result([{ type: 'text', text: value }])
const body = message => typeof message.content === 'string' ? message.content : (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')

/** The trace runner reads this only after selecting its exact execute run. A
 * completed model response cannot satisfy the independent publication wait. */
export function tracePublicationReady(row) {
  if (row && ['blocked', 'skipped'].includes(row.status)) throw new Error('EXECUTION_PUBLICATION_FAILED')
  return row?.status === 'published'
}

function output(messages, toolName, expectedRunId) {
  const part = messages.flatMap(message => Array.isArray(message.content) ? message.content : []).findLast(part => part.type === 'tool-result' && part.toolName === toolName)
  if (!part) return undefined
  // get_run returns the ended run's error as data. A real tool refusal has no
  // matching run identity/status; never confuse those two response contracts.
  const value = part.output?.value
  const runDetail = toolName === 'get_run' && value?.id === expectedRunId && ['succeeded', 'stopped', 'failed', 'cancelled'].includes(value?.status)
  if (part.output?.type !== 'json' || value?.error && !runDetail) throw fixtureModelError('MODEL_RESULT_REFUSED', toolName, value)
  return part.output.value
}

export function answerModel(request, scenario, observe = () => {}) {
  const prompt = request.prompt ?? []
  const start = scenario ? prompt.findLastIndex(message => message.role === 'user' && body(message).includes(scenario.marker)) : -1
  if (start < 0) return text('你想先做哪件事？')
  const messages = prompt.slice(start)
  const selected = body(prompt[start]).match(/The person selected device ([a-f0-9-]{36}) in the task dialog\./)?.[1]
  if (!scenario.deviceId || selected !== scenario.deviceId) throw fixtureModelError('MODEL_DESTINATION_MISMATCH')
  observe({ kind: 'destination', deviceId: selected })
  const call = (toolName, input, phase = 'dispatch') => {
    if (!request.tools?.some(tool => tool.name === toolName)) throw fixtureModelError('MODEL_TOOL_MISSING', toolName)
    const toolCallId = `${scenario.marker}-${phase}-${toolName}`
    observe({ kind: 'tool', toolName, toolCallId, input })
    return result([{ type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) }], 'tool-calls')
  }
  const ended = messages.findLastIndex(message => message.role === 'user' && /\[Event\] Run [a-f0-9-]{36} ended/.test(body(message)))
  if (ended >= 0) {
    const event = body(messages[ended])
    const runId = event.match(/\[Event\] Run ([a-f0-9-]{36}) ended/)?.[1]
    const recent = messages.slice(ended)
    const run = output(recent, 'get_run', runId)
    if (!run) return call('get_run', { runId }, 'result')
    if (run.id !== runId) throw fixtureModelError('MODEL_COMPLETION_MISMATCH', 'get_run')
    if (run.status !== 'succeeded') return text('线程已停止。')
    const task = output(recent, 'get_issue')
    if (!task) return call('get_issue', { issueId: run.issueId }, 'result')
    const url = event.match(/https:\/\/github\.com\/mikka-e2e\/core-loop\/pull\/\d+/)?.[0]
    if (scenario.harness === 'synthetic-codex' && !url) {
      if (run.id !== runId || task.id !== run.issueId || !run.summary) throw new Error('Completion reached the trace model without its real run, task or summary')
      observe({ kind: 'execution-ended', runId, issueId: task.id, publication: 'not_observed' })
      return text(`执行已结束：${run.summary}\n\n发布状态尚未确认。`)
    }
    if (!url || task.id !== run.issueId || !run.summary) throw new Error('Completion reached the model without the real task, summary or PR receipt')
    observe({ kind: 'result', runId, issueId: task.id, pullRequest: url })
    return text(`已完成：${run.summary}\n\nPR：${url}`)
  }
  const issue = output(messages, 'create_issue')
  if (!issue) return call('create_issue', { title: scenario.title, body: `Add MIKKA_MOCK.md to ${scenario.repo}. ${scenario.marker}` })
  const identities = output(messages, 'list_agents')
  if (!identities) return call('list_agents', {})
  const harness = scenario.harness === 'synthetic-codex' ? 'codex' : 'mock'
  const identity = identities.find(row => row.deviceId === selected && row.harness === harness && row.deviceOnline)
  if (!identity) throw fixtureModelError('MODEL_IDENTITY_MISSING', 'list_agents')
  const run = output(messages, 'dispatch_run')
  if (!run) return call('dispatch_run', { issueId: issue.id, agentId: identity.id, repo: scenario.repo })
  if (!run.runId) throw fixtureModelError('MODEL_RUN_NOT_QUEUED', 'dispatch_run')
  observe({ kind: 'dispatched', issueId: issue.id, runId: run.runId, deviceId: selected })
  return text('已在你选择的电脑上启动线程。')
}
