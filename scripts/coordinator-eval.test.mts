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
mock.module('@/workflows/coordinator/steps', { namedExports: Object.fromEntries(['dispatchRun', 'findRepository', 'getIssue', 'listIssues', 'createIssue', 'updateIssue', 'bindComputerSubscription', 'createComputerBot', 'githubMcp', 'listAgents', 'listRuns', 'getRun', 'startWebSubagent', 'wakeComputerBot', 'dispatchComputerThread', 'listComputerBots', 'listBotSubscriptions', 'listComputerWorkspaces', 'scheduleCommand', 'webSearchStep', 'sendToRun', 'stopRun', 'remember', 'forget', 'recordAttention', 'appTools', 'personalMcp'].map(name => [name, step(name)])) })
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
  // What the person sees before the first tool runs: the text of the first model call, when it also called a tool.
  const first = result.steps[0]
  return { reply: result.text, calls: [...log], opening: first && first.toolCalls.length ? first.text.trim() : null, steps: result.steps.length }
}

/** Runs `grade` on TRIALS trials; prints each failing transcript. */
type Outcome = { reply: string; calls: { step: string; input: unknown }[]; opening?: string | null; steps?: number }
async function passAll(name: string, run: () => Promise<Outcome>, grade: (outcome: Outcome) => string | null) {
  const failures: string[] = []
  for (let index = 0; index < TRIALS; index++) {
    const outcome = await run()
    const why = grade(outcome)
    if (why) failures.push(`trial ${index + 1}: ${why}\n  calls: ${JSON.stringify(outcome.calls)}\n  opening: ${outcome.opening ?? '(none)'}\n  reply: ${outcome.reply}`)
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
  results = { getIssue: { id: ISSUE, title: '登录流程' }, listComputerBots: [{ botId: BOT, name: 'Coordinator', harnesses: ['claude_code'] }], wakeComputerBot: { state: 'awake' }, dispatchComputerThread: { runId: 'run-4' }, startWebSubagent: { subagentId: 'sub-1', state: 'running' }, dispatchRun: { runId: 'run-5', thread: 'new' }, createIssue: { id: '00000000-0000-4000-8000-0000000000a2', title: '修复 lib/foo.ts 的类型错误', status: 'todo' } }
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
  const thread = { id: ISSUE, title: '加 README', status: 'doing', body: '给 Mikka_test 加一个 README。', runs: [{ id: 'run-1', agent: 'Claude Code', status: 'running' }], thread: { runId: 'run-1', status: 'running', repository: 'https://github.com/alexj11324/Mikka_test' } }
  results = { getIssue: thread, dispatchRun: { thread: 'message', runId: 'run-1', threadId: 'run-1', status: 'messageSent' }, sendToRun: { sent: true } }
  await passAll('follow-up', async () => trial('README 里再加一节安装说明', await facts()), ({ calls, reply }) => {
    if (calls.some(call => call.step === 'dispatchRun' && (call.input as { newThread?: boolean }).newThread === true)) return 'asked for a new thread'
    if (calls.some(call => call.step === 'findRepository')) return 'looked up a repository for a task that has a thread'
    if (/哪个仓库|which repositor/i.test(reply)) return 'asked for a repository'
    return calls.some(call => call.step === 'dispatchRun' || call.step === 'sendToRun') ? null : 'did not pass the work on'
  })
  results = { getIssue: thread, dispatchRun: { runId: 'run-2', thread: 'new', threadId: 'run-2', replacedThreadId: 'run-1' } }
  await passAll('explicit new thread', async () => trial('另开一个线程，用 Codex 从头重新做这个任务', await facts()), ({ calls }) =>
    calls.some(call => call.step === 'dispatchRun' && (call.input as { newThread?: boolean }).newThread === true) ? null : 'no new thread though the person asked')
})

test('a turn that needs tools opens with one specific sentence before the first tool, and the reply does not repeat it', { skip }, async () => {
  results = { getIssue: { id: ISSUE, title: '加 README', thread: null }, findRepository: { match: 'one', repository: 'alexj11324/Mikka_test' }, dispatchRun: { runId: 'run-6', thread: 'new', placement: { kind: 'device', name: 'Alex 的 MacBook' } } }
  const openings = new Set<string>()
  await passAll('opening', async () => trial('派发任务，给 Mikka_test 写一个简单的 README', await facts()), ({ reply, calls, opening }) => {
    if (!called(calls, 'dispatchRun')) return 'no dispatch_run'
    if (!opening) return 'no sentence before the first tool call'
    if (opening.length > 80) return 'opening is not short'
    if (!/README|Mikka_test|任务|派|线程|Claude|Codex/i.test(opening)) return 'opening does not name what it does'
    if (reply.trim() && reply.includes(opening)) return 'the reply repeats the opening'
    openings.add(opening)
    return null
  })
})

test('a message that needs no tool is answered at once, with no opening sentence', { skip }, async () => {
  results = {}
  await passAll('no tool', async () => trial('谢谢，没别的事了', await facts()), ({ reply, calls, steps }) => {
    if (calls.length) return 'called a tool'
    if (!reply.trim()) return 'silent'
    if ((steps ?? 1) > 1) return 'took more than one model call'
    return null
  })
})

// Alex's own words, from the Acme production thread (2026-11-03), each with two rewordings on other repositories:
// none of these sentences or repository names is in the prompt, so passing means judging, not recalling.
type Family = { app: string; site: string; other: string; siteHome: string }
const MIKKA: Family = { app: 'alexj11324/Mikka', site: 'alexj11324/mikka-web', other: 'acme/mikka-enterprise', siteHome: 'https://mikka.example' }
const OCTO: Family = { app: 'octo/octo', site: 'octo/octo-web', other: 'octo/octo-api', siteHome: 'https://octo.example' }
const candidatesOf = (family: Family) => [
  { fullName: family.app, description: 'The product: app, API clients and background jobs', homepage: `https://app.${family.siteHome.slice(8)}`, usedByThisWorkspace: true },
  { fullName: family.site, description: 'The public marketing website', homepage: family.siteHome, usedByThisWorkspace: false },
  { fullName: family.other, description: null, homepage: null, usedByThisWorkspace: false },
]
const cardOf = (family: Family, name: string) => ({ title: `多个仓库匹配 ${name}`, options: candidatesOf(family).map(item => ({ value: item.fullName, label: item.fullName })) })
const repoOf = (call: { input: unknown }) => String((call.input as { repo?: string }).repo ?? '')
const named = (repo: string, fullName: string) => {
  const short = fullName.split('/')[1]!
  return repo.toLowerCase() === fullName.toLowerCase() || repo.toLowerCase() === short.toLowerCase() || new RegExp(`github\\.com/${fullName}(\\.git)?$`, 'i').test(repo)
}

const siteCases: { label: string; text: string; family: Family; name: string }[] = [
  { label: 'Alex', text: 'On phones, the How it works section on the Mikka site is cut off. Can you fix it?', family: MIKKA, name: 'Mikka site' },
  { label: 'landing page', text: "The pricing table on Octo's landing page overflows on small screens, please fix it.", family: OCTO, name: 'Octo landing page' },
  { label: 'website', text: 'Octo 官网首页的页脚在手机上被截断了，帮忙修一下', family: OCTO, name: 'Octo 官网' },
]
for (const item of siteCases) {
  test(`site request (${item.label}): 「${item.text}」 goes to the site repository or asks; never to the app`, { skip }, async () => {
    results = {
      getIssue: { id: ISSUE, title: item.text.slice(0, 60), thread: null },
      findRepository: { match: 'several', candidates: candidatesOf(item.family), card: cardOf(item.family, item.name) },
      dispatchRun: { error: 'repositoryAmbiguous', issueId: ISSUE, candidates: candidatesOf(item.family), card: cardOf(item.family, item.name) },
    }
    await passAll(`site ${item.label}`, async () => {
      const outcome = await trial(item.text, await facts())
      return outcome
    }, ({ reply, calls }) => {
      const dispatched = calls.filter(call => call.step === 'dispatchRun' && repoOf(call))
      if (dispatched.some(call => named(repoOf(call), item.family.app))) return `dispatched to the app repository ${item.family.app}`
      if (dispatched.some(call => named(repoOf(call), item.family.site))) return null
      return /BeQuestions/.test(reply) ? null : 'neither the site repository nor a question'
    })
  })
}

const moveCases: { label: string; text: string; family: Family }[] = [
  { label: 'Alex', text: "It's in the mikka-web repo", family: MIKKA },
  { label: 'wrong repo', text: 'Wrong repository — this lives in octo-web, not octo.', family: OCTO },
  { label: 'zh', text: '这个改动应该在 octo-web 仓库里做', family: OCTO },
]
for (const item of moveCases) {
  test(`named repository (${item.label}): 「${item.text}」 on a thread bound to ${item.family.app} moves the work there`, { skip }, async () => {
    const thread = { id: ISSUE, title: 'Section cut off on phones', status: 'doing', runs: [{ id: 'run-1', agent: 'Claude Code', status: 'completed' }], thread: { runId: 'run-1', status: 'completed', repository: `https://github.com/${item.family.app}` } }
    results = { getIssue: thread, findRepository: { match: 'one', repository: item.family.site, description: 'The public marketing website', homepage: item.family.siteHome }, dispatchRun: { runId: 'run-8', thread: 'new', threadId: 'run-8', replacedThreadId: 'run-1', placement: { kind: 'cloud' } } }
    await passAll(`move ${item.label}`, async () => trial(item.text, await facts()), ({ calls }) => {
      const dispatched = calls.filter(call => call.step === 'dispatchRun')
      if (!dispatched.length) return 'no dispatch_run'
      return dispatched.some(call => named(repoOf(call), item.family.site)) ? null : 'continued the old thread without the named repository'
    })
  })
}

const screenCases: { label: string; text: string; family: Family; mention: RegExp }[] = [
  { label: 'Alex', text: 'On phones, the How it works section on the Mikka site is cut off. First show me the page at phone width.', family: MIKKA, mention: /mikka/i },
  { label: 'docs site', text: 'Open our Octo docs site on a narrow browser and show me where the sidebar breaks.', family: OCTO, mention: /octo/i },
  { label: 'zh', text: '先用手机尺寸打开 Octo 官网给我看看导航栏', family: OCTO, mention: /octo/i },
]
for (const item of screenCases) {
  test(`screen work (${item.label}) names the site to the sub-agent`, { skip }, async () => {
    results = { getIssue: { id: ISSUE, title: 'Check on a phone', thread: null }, startWebSubagent: { subagentId: 'sub-9', state: 'running' }, dispatchComputerThread: { runId: 'run-9' }, listComputerBots: [{ botId: BOT, name: 'Coordinator', harnesses: ['claude_code'] }], wakeComputerBot: { state: 'awake' } }
    await passAll(`screen ${item.label}`, async () => trial(item.text, await facts(), { computerEnabled: true }), ({ calls }) => {
      const started = calls.find(call => call.step === 'startWebSubagent' || call.step === 'dispatchComputerThread')
      if (!started) return 'did not start screen work'
      return item.mention.test(JSON.stringify(started.input)) ? null : 'the sub-agent was not told which site'
    })
  })
}
