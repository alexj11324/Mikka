// Scripts at the LiteLLM HTTP boundary. No production modules or tools are mocked.
import { randomUUID } from 'node:crypto'
import { answerDecision } from '../../tests/mvp/decisions.mjs'
import { localLoopModelAnswer, localGroupDecision } from './model-scripts.mjs'
import { nativeLocalModelAnswer } from './native-model-script.mjs'

export const textOf = message => typeof message?.content === 'string' ? message.content
  : (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
const text = value => ({ content: [{ type: 'text', text: value }], finishReason: 'stop' })
const call = (toolName, input) => ({ content: [{ type: 'tool-call', toolCallId: `local-${randomUUID()}`, toolName, input: JSON.stringify(input) }], finishReason: 'tool-calls' })

/** Only explicitly scripted request features match; an unfamiliar prompt fails. */
export function localModelAnswer(request) {
  const prompt = request.prompt ?? []
  const user = textOf(prompt.findLast(message => message.role === 'user')).trim()
  const command = /^\/tool\s+([\w.-]+)\s*([\s\S]*)$/.exec(user.split('\n').findLast(line => line.startsWith('/tool ')) ?? '')
  if (command) {
    const [, toolName, raw] = command
    if (!request.tools?.some(tool => tool.name === toolName)) return null
    const last = prompt.at(-1)
    if (last?.role === 'tool') {
      const results = (last.content ?? []).filter(part => part.type === 'tool-result' && part.toolName === toolName)
      if (results.length) return text(results.map(part => `${part.toolName}: ${JSON.stringify(part.output?.value ?? part.output ?? null)}`).join('\n'))
    }
    let input
    try { input = raw.trim() ? JSON.parse(raw) : {} } catch { return null }
    return call(toolName, input)
  }
  if (user.startsWith('/echo ')) return text(`Local model: ${user.slice(6)}`)
  if (request.model === 'mikka-title' && prompt.some(message => message.role === 'system' && textOf(message).includes('为编码线程起一个'))) {
    const value = JSON.parse(user)
    if (value.task && typeof value.task.title === 'string') return text(JSON.stringify({ title: '检查本地任务' }))
  }
  return localLoopModelAnswer(request) ?? nativeLocalModelAnswer(request)
}

export function localDecision(input) {
  if (input.input === '[fixture:decision]') return {
    model: input.model,
    answers: (input.questions ?? []).map(question => question.type === 'choice'
      ? { type: 'choice', name: question.name, choice: question.choices?.[0]?.value }
      : { type: 'predicate', name: question.name, probability: 0.5 }),
  }
  return localGroupDecision(input) ?? answerDecision(input)
}
