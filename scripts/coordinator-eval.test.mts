// Live-model Coordinator scenarios (optional, never in CI). The same scenarios
// as lib/coordinator/scenarios.test.ts, but a real model chooses the calls:
// each scenario runs EVAL_TRIALS times (default 3) and must pass every time
// (pass^k). Graders are code: which tools were called with what, and what the
// reply must not say. Tools are stubbed with fixed results; nothing reaches a
// database, a device or GitHub.
//
//   COORDINATOR_EVAL_MODEL=<gateway model id> AI_GATEWAY_API_KEY=… pnpm eval:coordinator
//   COORDINATOR_EVAL_MODEL=<DeepSeek model id> DEEPSEEK_API_KEY=… pnpm eval:coordinator
//
// A DeepSeek key goes to DeepSeek's OpenAI-compatible chat endpoint (the one a
// bot chat on that key uses, lib/model-api-key-providers.ts); otherwise the AI
// Gateway. Without a model and one of the keys every scenario is skipped. Read the transcripts it
// prints for a failing trial before changing the prompt.
import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { gateway, generateText, stepCountIs, type LanguageModel, type ToolSet } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { API_KEY_PRESET_ENDPOINTS } from '../lib/model-api-key-providers.ts'

const MODEL = process.env.COORDINATOR_EVAL_MODEL
const TRIALS = Number(process.env.EVAL_TRIALS ?? 3)
const DEEPSEEK = process.env.DEEPSEEK_API_KEY
const skip = !MODEL || !(DEEPSEEK || process.env.AI_GATEWAY_API_KEY) ? 'set COORDINATOR_EVAL_MODEL and DEEPSEEK_API_KEY or AI_GATEWAY_API_KEY to run' : false
const evalModel = (): LanguageModel => DEEPSEEK
  ? createOpenAICompatible({ name: 'deepseek', baseURL: API_KEY_PRESET_ENDPOINTS.deepseek.chatBaseUrl, apiKey: DEEPSEEK })(MODEL!)
  : gateway(MODEL!)

const OWNER = 'alex'
const BOT = '00000000-0000-4000-8000-0000000c0de1'
const ISSUE = '00000000-0000-4000-8000-0000000000a1'
const noModelsCard = { title: '没有能跑这个任务的模型', description: '还没有允许使用的模型', options: [{ value: 'models', label: '去模型与订阅', action: 'modelSettings' }] }
const notFoundCard = { title: '没找到这个仓库', description: '你的 GitHub 里没有叫 Mikka_tset 的仓库', options: [{ value: 'install', label: '去 GitHub 授权', action: 'githubInstall' }] }

/** Per-scenario results for the stubbed steps; each call is logged. */
let results: Record<string, unknown> = {}
const log: { step: string; input: unknown }[] = []
const step = (name: string) => async (...args: unknown[]) => { log.push({ step: name, input: args[1] }); return results[name] ?? { ok: true } }
mock.module('@/workflows/coordinator/steps', { namedExports: Object.fromEntries(['dispatchRun', 'findRepository', 'getIssue', 'listIssues', 'listAgents', 'listRuns', 'getRun', 'startWebSubagent', 'wakeComputerBot', 'dispatchComputerThread', 'listComputerBots', 'listBotSubscriptions', 'listComputerWorkspaces', 'scheduleCommand', 'webSearchStep', 'sendToRun', 'stopRun', 'remember', 'forget', 'recordAttention', 'appTools', 'personalMcp'].map(name => [name, step(name)])) })
mock.module('@/workflows/coordinator/agent-kit-steps', { namedExports: {} })
mock.module('@/lib/composio-actions', { namedExports: { createComposioAITools: () => ({}), createGoogleAITools: () => ({}) } })

let createRegistry: typeof import('../workflows/coordinator/tools').createCoordinatorRegistry
let base: string
before(async () => {
  if (skip) return
  createRegistry = (await import('../workflows/coordinator/tools')).createCoordinatorRegistry
  const { COORDINATOR_INSTRUCTIONS } = await import('../lib/coordinator/instructions')
  const { withCoordinatorPresentation } = await import('../lib/coordinator/native-prompt')
  const { githubContext } = await import('../lib/coordinator/github-context')
  const github = await githubContext(OWNER, { connection: async () => ({ githubLogin: 'alexj11324' }), list: async () => ({ login: 'alexj11324', installationAccounts: ['alexj11324'], repositories: Array.from({ length: 50 }, (_, index) => index) }) })
  base = `${withCoordinatorPresentation(COORDINATOR_INSTRUCTIONS)}\n${github}`
})

async function facts(overrides: Partial<import('../lib/coordinator/execution-context').ExecutionFacts> = {}) {
  const { executionContextText } = await import('../lib/coordinator/execution-context')
  return executionContextText({
    workspace: { name: 'Alex', kind: 'personal' },
    devices: [{ name: 'Alex 的 MacBook', online: true, enabled: true, agents: ['Claude Code', 'Codex'] }],
    order: { location: 'local', entries: [{ agent: 'Claude Code', model: 'opus', provider: 'anthropic', block: null }, { agent: 'Codex', model: 'gpt-codex', provider: 'openai', block: null }], credentials: [{ kind: 'subscription', provider: 'anthropic' }, { kind: 'subscription', provider: 'openai' }] },
    e2b: false,
    hosted: 'ready',
    ...overrides,
  })
}

async function trial(text: string, context: string, options: { computerEnabled?: boolean } = {}) {
  log.length = 0
  const tools: ToolSet = createRegistry(OWNER, BOT, undefined, { coordinator: true, ...options })
  const result = await generateText({ model: evalModel(), system: `${base}\n${context}`, prompt: `This chat is linked to issue ${ISSUE}.\n\n${text}`, tools, stopWhen: stepCountIs(8) })
  return { reply: result.text, calls: [...log] }
}

/** Runs `grade` on TRIALS trials; prints each failing transcript. */
async function passAll(name: string, run: () => Promise<{ reply: string; calls: { step: string; input: unknown }[] }>, grade: (outcome: { reply: string; calls: { step: string; input: unknown }[] }) => string | null) {
  const failures: string[] = []
  for (let index = 0; index < TRIALS; index++) {
    const outcome = await run()
    const why = grade(outcome)
    if (why) failures.push(`trial ${index + 1}: ${why}\n  calls: ${JSON.stringify(outcome.calls)}\n  reply: ${outcome.reply}`)
  }
  assert.equal(failures.length, 0, `${name}: ${TRIALS - failures.length}/${TRIALS} passed\n${failures.join('\n')}`)
}
const called = (calls: { step: string }[], name: string) => calls.some(call => call.step === name)

test('在 Mikka_test 里加 README: finds the repository, never asks which account', { skip }, async () => {
  results = { getIssue: { id: ISSUE, title: '加 README' }, findRepository: { match: 'one', repository: 'alexj11324/Mikka_test' }, dispatchRun: { runId: 'run-1', thread: 'new', placement: { kind: 'device', name: 'Alex 的 MacBook' } } }
  await passAll('readme', async () => trial('在 Mikka_test 里加一个 README', await facts()), ({ reply, calls }) => {
    const dispatched = calls.find(call => call.step === 'dispatchRun')
    if (!dispatched) return 'no dispatch_run'
    if (!/mikka_test/i.test(String((dispatched.input as { repo?: string }).repo))) return 'dispatched to another repository'
    if (/账号|账户|account|哪个 ?(GitHub|owner)/i.test(reply)) return 'asked about the account'
    return null
  })
})

test('Mikka 默认 out of points and no model for threads: says so with the card, never claims it runs', { skip }, async () => {
  results = { getIssue: { id: ISSUE, title: '修复登录页类型错误' }, dispatchRun: { error: 'machineUnavailable', reason: 'noModels', issueId: ISSUE, card: noModelsCard } }
  await passAll('points', async () => trial('在 alexj11324/Mikka 修复登录页的类型错误', await facts({ order: { location: 'local', entries: [], credentials: [] }, hosted: 'points_exhausted' })), ({ reply }) => {
    if (!reply.trim()) return 'silent'
    if (/已(经)?(派|开始|在跑)|is running|started/.test(reply)) return 'claimed it runs'
    if (!/BeQuestions|模型与订阅|订阅|Key/.test(reply)) return 'no way on (card, subscription or key)'
    return null
  })
})

test('派给 Codex: the Agent is passed, no model id is asked for', { skip }, async () => {
  results = { getIssue: { id: ISSUE, title: '修 README 拼写' }, dispatchRun: { runId: 'run-3', thread: 'new', placement: { kind: 'device', name: 'Alex 的 MacBook' } } }
  await passAll('codex', async () => trial('把这个任务派给 Codex：在 alexj11324/Mikka 修复 README 的拼写', await facts()), ({ reply, calls }) => {
    const dispatched = calls.find(call => call.step === 'dispatchRun')
    if (!dispatched) return 'no dispatch_run'
    if ((dispatched.input as { model?: { harness?: string } }).model?.harness !== 'codex') return 'not Codex'
    if (/哪个模型|which model/i.test(reply)) return 'asked for a model'
    return null
  })
})

test('watching a front-end test uses the Bot computer; a code fix goes to an Agent', { skip }, async () => {
  results = { getIssue: { id: ISSUE, title: '登录流程' }, listComputerBots: [{ botId: BOT, name: 'Coordinator', harnesses: ['claude_code'] }], wakeComputerBot: { state: 'awake' }, dispatchComputerThread: { runId: 'run-4' }, startWebSubagent: { subagentId: 'sub-1', state: 'running' }, dispatchRun: { runId: 'run-5', thread: 'new' } }
  await passAll('screen', async () => trial('打开 Mikka 的预览，看着登录流程的前端测试跑一遍', await facts(), { computerEnabled: true }), ({ calls }) =>
    called(calls, 'dispatchRun') ? 'dispatched to an Agent' : !(called(calls, 'startWebSubagent') || called(calls, 'dispatchComputerThread')) ? 'did not use the computer' : null)
  await passAll('code', async () => trial('修复 alexj11324/Mikka 里 lib/foo.ts 的类型错误', await facts(), { computerEnabled: true }), ({ calls }) =>
    !called(calls, 'dispatchRun') ? 'no dispatch_run' : called(calls, 'dispatchComputerThread') ? 'used the computer' : null)
})

test('a repository that does not exist: asking is right (negative case)', { skip }, async () => {
  results = { getIssue: { id: ISSUE, title: '加 README' }, findRepository: { match: 'none', card: notFoundCard }, dispatchRun: { error: 'repositoryNotFound', card: notFoundCard } }
  await passAll('not found', async () => trial('在 Mikka_tset 里加一个 README', await facts()), ({ reply }) => /BeQuestions/.test(reply) ? null : 'did not draw the card')
})

test('more work on a task stays in its thread; a new one only when the person asks', { skip }, async () => {
  const thread = { id: ISSUE, title: '加 README', latestRuns: [{ id: 'run-1', status: 'running', thread: 'run-1' }] }
  results = { getIssue: thread, dispatchRun: { thread: 'message', runId: 'run-1', threadId: 'run-1', status: 'messageSent' }, sendToRun: { sent: true } }
  await passAll('follow-up', async () => trial('README 里再加一节安装说明', await facts()), ({ calls }) => {
    if (calls.some(call => call.step === 'dispatchRun' && (call.input as { newThread?: boolean }).newThread === true)) return 'asked for a new thread'
    return calls.some(call => call.step === 'dispatchRun' || call.step === 'sendToRun') ? null : 'did not pass the work on'
  })
  results = { getIssue: thread, dispatchRun: { runId: 'run-2', thread: 'new', threadId: 'run-2', replacedThreadId: 'run-1' } }
  await passAll('explicit new thread', async () => trial('另开一个线程，用 Codex 从头重新做这个任务', await facts()), ({ calls }) =>
    calls.some(call => call.step === 'dispatchRun' && (call.input as { newThread?: boolean }).newThread === true) ? null : 'no new thread though the person asked')
})
