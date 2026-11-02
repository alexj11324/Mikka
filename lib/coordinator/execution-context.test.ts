import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executionContext, executionContextText, readExecutionFacts, type ExecutionContextSource, type ExecutionFacts } from './execution-context'
import { deliverRefusalLine, failureLine } from './refusal-line'
import { chatFailure, failureMessageKey } from '../chat-failure'

const facts: ExecutionFacts = {
  workspace: { name: 'Alex', kind: 'personal' },
  devices: [{ name: 'Alex 的 MacBook', online: true, enabled: true, agents: ['Claude Code', 'Codex'] }, { name: 'server', online: false, enabled: false, agents: [] }],
  order: {
    location: 'local',
    entries: [
      { agent: 'Claude Code', model: 'opus', provider: 'anthropic', block: null },
      { agent: 'Codex', model: 'gpt-codex', provider: 'openai', block: 'quota' },
      { agent: 'Codex', model: 'gpt-mini', provider: 'openai', block: null },
      { agent: 'Claude Code', model: 'sonnet', provider: 'anthropic', block: null },
    ],
    credentials: [{ kind: 'subscription', provider: 'anthropic' }, { kind: 'api_key', provider: 'openai' }],
  },
  e2b: false,
  hosted: 'points_exhausted',
}

test('every configured fact reaches the prompt, with the rule not to ask about it', () => {
  const text = executionContextText(facts)
  assert.match(text, /Workspace of this chat: Alex \(personal\)/)
  assert.match(text, /Alex 的 MacBook \(online, Claude Code and Codex\)/)
  assert.match(text, /server \(offline, 参与调度 off, no Agent installed\)/)
  assert.match(text, /anthropic subscription, openai API key/)
  assert.match(text, /运行位置 本地\): Claude Code opus; Codex gpt-codex \(cannot run now: quota\); Codex gpt-mini; and 1 more/)
  assert.match(text, /no E2B key/)
  assert.match(text, /Mikka 默认 .* points_exhausted/)
  assert.match(text, /do not ask the person about them/)
})

test('nothing connected says what dispatch does instead of inviting a question', () => {
  const text = executionContextText({ ...facts, order: { location: 'cloud', entries: [], credentials: [] }, hosted: 'ready', devices: [] })
  assert.match(text, /No subscription or API key is connected for threads; dispatch_run returns a card/)
  assert.match(text, /no computer connected/)
  assert.doesNotMatch(text, /Mikka 默认/, 'a ready Mikka 默认 is not worth a line')
  assert.doesNotMatch(text, /Preferred models/)
})

test('a part that fails or is slow is left out, never claimed missing', async () => {
  const source: ExecutionContextSource = {
    workspace: async () => facts.workspace,
    devices: async () => { throw new Error('db down') },
    order: () => new Promise(() => {}),
    e2b: async () => true,
    hosted: async () => 'usage_in_progress',
  }
  const read = await readExecutionFacts('alex', 'bot', source, 20)
  assert.equal(read.devices, null)
  assert.equal(read.order, null)
  const text = await executionContext('alex', 'bot', source, 20)
  assert.doesNotMatch(text, /computer/)
  assert.doesNotMatch(text, /subscription|API key/)
  assert.doesNotMatch(text, /Mikka 默认/, 'a passing busy state is not a refusal')
  assert.match(text, /own E2B key/)
  assert.equal(executionContextText({ workspace: null, devices: null, order: null, e2b: null, hosted: null }), '')
})

test('a failure the person can act on becomes the words the web keeps under the message', () => {
  assert.equal(failureLine('Error: points_exhausted'), 'Mikka 默认点数已用完')
  assert.equal(failureLine('free_allowance_used'), 'Mikka 默认免费额度已用完')
  assert.equal(failureLine('verification_required'), '使用 Mikka 默认模型前需要验证银行卡')
  assert.equal(failureLine('usage_concurrency_limit'), 'Mikka 默认暂时不可用')
  assert.equal(failureLine('points_exhausted', 'en'), 'Mikka Default: Points used up')
  // The person's subscription refused the turn.
  assert.equal(failureLine('quota_exhausted'), '订阅额度已用完')
  assert.equal(failureLine('Step "model" failed after 3 retries: reconnect_required'), '订阅需要重新连接')
  assert.equal(failureLine('binding_required'), '订阅选择已失效')
  // The wake gave up: no turn ran.
  assert.equal(failureLine('wake_exhausted'), '回复重试已停止')
  // A crash is retried and has nothing for the person to do.
  assert.equal(failureLine('agent_runtime_changed'), null)
  assert.equal(failureLine(null), null)
})

test('every failure kind has one message key, the one the web line reads', () => {
  assert.deepEqual(failureMessageKey({ kind: 'hosted', code: 'usage_in_progress' }), { namespace: 'Billing.refusal', key: 'unavailable' })
  assert.deepEqual(failureMessageKey({ kind: 'hosted', code: 'verification_required' }), { namespace: 'Billing.refusal', key: 'verificationRequiredPlain' })
  assert.deepEqual(failureMessageKey({ kind: 'subscription', notice: 'quotaUsed' }), { namespace: 'Coordinator', key: 'subscriptionRefusal.quotaUsed' })
  assert.deepEqual(failureMessageKey({ kind: 'wake', code: 'wake_failed' }), { namespace: 'Coordinator', key: 'wakeErrors.wake_failed' })
  assert.deepEqual(failureMessageKey({ kind: 'failed' }), { namespace: 'Coordinator', key: 'failedTitle' })
  // Every key resolves in both languages, so no surface shows a raw key.
  for (const error of ['points_exhausted', 'free_allowance_used', 'platform_paused', 'verification_required', 'usage_cost_unavailable', 'binding_required', 'pending_auth', 'quota_exhausted', 'backend_unavailable', 'wake_failed', 'wake_start_unconfirmed', 'wake_exhausted']) {
    const failure = chatFailure({ working: false, error })!
    assert.notEqual(failure.kind, 'failed', error)
    for (const locale of ['zh-CN', 'en'] as const) assert.ok(failureLine(error, locale), `${error} in ${locale}`)
  }
})

test('the refusal reaches every Telegram chat and the phone; one failure does not stop the rest', async () => {
  const sent: string[] = []
  const pushed: unknown[] = []
  const result = await deliverRefusalLine('Mikka 默认点数已用完', ['t1', 't2', 't3'], [{ kind: 'run_finished' }], {
    telegram: async (target, text) => { if (target === 't2') throw new Error('telegram down'); sent.push(`${target}:${text}`) },
    push: async (text, events) => { pushed.push([text, events]) },
  })
  assert.deepEqual(sent, ['t1:Mikka 默认点数已用完', 't3:Mikka 默认点数已用完'])
  assert.deepEqual(pushed, [['Mikka 默认点数已用完', [{ kind: 'run_finished' }]]])
  assert.deepEqual(result.failed, ['telegram'])
  const quiet = await deliverRefusalLine('x', [], [], { telegram: async () => assert.fail('no target'), push: async () => assert.fail('no event') })
  assert.deepEqual(quiet.failed, [])
})
