import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { asSchema, generateText, stepCountIs, type ToolSet } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { overrideDeploymentSwitch } from '../deployment-switches'

/**
 * Coordinator scenarios with recorded model replies: the real system prompt
 * (instructions, the GitHub and execution facts) and the real tool registry,
 * a model that replays a recorded turn, and the steps behind the tools
 * mocked. Each scenario checks what the model is told, that the recorded
 * call fits the tool's schema, and which step it reaches with which input.
 * The live-model version of these scenarios is scripts/coordinator-eval.mts.
 */
const OWNER = 'alex'
const COORDINATOR_BOT = '00000000-0000-4000-8000-0000000c0de1'
const ISSUE = '00000000-0000-4000-8000-0000000000a1'

const calls: { step: string; input: unknown }[] = []
const step = (name: string, result: unknown = { ok: true }) => async (...args: unknown[]) => { calls.push({ step: name, input: args[1] }); return results[name] ?? result }
/** A scenario's own step results, for the steps it needs to answer differently. */
const results: Record<string, unknown> = {}
mock.module('@/workflows/coordinator/steps', { namedExports: {
  dispatchRun: step('dispatchRun', { runId: 'run-1', thread: 'new', placement: { kind: 'device', name: 'Alex 的 MacBook' } }),
  findRepository: step('findRepository', { match: 'one', repository: 'alexj11324/Mikka_test' }),
  getIssue: step('getIssue', { id: ISSUE, title: 'Add a README' }),
  startWebSubagent: step('startWebSubagent', { subagentId: 'sub-1', state: 'running' }),
  wakeComputerBot: step('wakeComputerBot', { state: 'awake' }),
  dispatchComputerThread: step('dispatchComputerThread', { runId: 'run-2' }),
  listComputerBots: step('listComputerBots', []),
  scheduleCommand: step('scheduleCommand'),
} })
mock.module('@/workflows/coordinator/agent-kit-steps', { namedExports: {} })
mock.module('@/lib/composio-actions', { namedExports: { createComposioAITools: () => ({}), createGoogleAITools: () => ({}) } })

let registry: typeof import('@/workflows/coordinator/tools')
let instructions: string
let systemPrompt: (computer?: boolean) => Promise<string>
before(async () => {
  registry = await import('@/workflows/coordinator/tools')
  instructions = (await import('./instructions')).COORDINATOR_INSTRUCTIONS
  const { githubContext } = await import('./github-context')
  const { executionContextText, modelListText } = await import('./execution-context')
  const github = await githubContext(OWNER, {
    connection: async () => ({ githubLogin: 'alexj11324' }),
    list: async () => ({ login: 'alexj11324', installationAccounts: ['alexj11324'], repositories: Array.from({ length: 50 }, (_, index) => index) }),
  })
  // As in the real prompt: the allowed models list (cached prefix), then what changes per turn.
  const execution = ((f: Parameters<typeof executionContextText>[0]) => `${modelListText(f)}\n${executionContextText(f)}`)({
    workspace: { name: 'Alex', kind: 'personal' },
    devices: [{ name: 'Alex 的 MacBook', online: true, enabled: true, agents: ['Claude Code', 'Codex'] }],
    order: { location: 'local', entries: [{ harness: 'claude_code', agent: 'Claude Code', model: 'opus', source: 'subscription', provider: 'anthropic', places: ['Alex 的 MacBook (computer)'], block: null }, { harness: 'codex', agent: 'Codex', model: 'gpt-codex', source: 'subscription', provider: 'openai', places: ['Alex 的 MacBook (computer)'], block: null }], credentials: [{ kind: 'subscription', provider: 'anthropic' }, { kind: 'subscription', provider: 'openai' }] },
    e2b: false,
    hosted: 'points_exhausted',
  })
  systemPrompt = async () => `${instructions}\n${github}\n${execution}`
})
beforeEach(() => { calls.length = 0; for (const key of Object.keys(results)) delete results[key]; overrideDeploymentSwitch('issueTools', true) })

type Recorded = { tool: string; input: Record<string, unknown> } | { text: string }
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }

/** Replays `turn` one model step at a time, through the real tools; returns what the model was told and the reply. */
async function play(userText: string, turn: Recorded[], options: { computerEnabled?: boolean } = {}) {
  const tools: ToolSet = registry.createCoordinatorRegistry(OWNER, COORDINATOR_BOT, undefined, { coordinator: true, ...options })
  const system = await systemPrompt(options.computerEnabled)
  let index = 0
  const model = new MockLanguageModelV3({ doGenerate: async () => {
    const next = turn[index++]
    if (!next) return { content: [{ type: 'text', text: '' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }
    if ('text' in next) return { content: [{ type: 'text', text: next.text }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }
    return { content: [{ type: 'tool-call', toolCallId: `call-${index}`, toolName: next.tool, input: JSON.stringify(next.input) }], finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage, warnings: [] }
  } })
  const result = await generateText({ model, system, prompt: userText, tools, stopWhen: stepCountIs(turn.length + 1) })
  const failed = result.steps.flatMap(item => item.content.filter(part => part.type === 'tool-error'))
  assert.deepEqual(failed, [], 'every recorded call fits its tool')
  return { system, tools, reply: result.text }
}

test('「在 Mikka_test 里加 README」: the account is known, the bare name goes to dispatch, nobody is asked which account', async () => {
  const { system, reply } = await play('在 Mikka_test 里加一个 README', [
    { tool: 'get_issue', input: { issueId: ISSUE } },
    { tool: 'dispatch_run', input: { issueId: ISSUE, repo: 'Mikka_test' } },
    { text: '已经派给 Agent 在 Alex 的 MacBook 上做了。' },
  ])
  assert.match(system, /connected GitHub account is @alexj11324/)
  assert.match(system, /Never ask which account or owner a repository is under/)
  assert.deepEqual(calls.map(call => call.step), ['getIssue', 'dispatchRun'])
  assert.equal((calls[1].input as { repo: string }).repo, 'Mikka_test', 'the name the person used reaches the host lookup unchanged')
  assert.doesNotMatch(reply, /账号|account|BeQuestions/)
})

test('Mikka 默认 out of points: the model is told, threads never claim to run on it, and dispatch rules point at the card', async () => {
  const { system, tools } = await play('帮我修一下类型错误', [{ tool: 'dispatch_run', input: { issueId: ISSUE, repo: 'alexj11324/Mikka' } }])
  assert.match(system, /Mikka 默认 \(the model for Bot chats\) cannot answer right now: points_exhausted/)
  assert.doesNotMatch(system, /the run uses Mikka's default model/, 'the rule decision 2026-11-02-1400 replaced is gone')
  assert.match(system, /Threads never run on Mikka 默认/)
  assert.match(String(tools.dispatch_run.description), /Threads never run on Mikka 默认/)
  assert.match(String(tools.dispatch_run.description), /adding a subscription or key/)
})

test('「派给 Codex」: the Agent alone is a valid choice; no model id is asked for', async () => {
  const { system } = await play('这个派给 Codex', [{ tool: 'dispatch_run', input: { issueId: ISSUE, repo: 'alexj11324/Mikka', model: { harness: 'codex' } } }])
  assert.match(system, /pass model with harness only; never ask them for a model id/)
  assert.deepEqual((calls[0].input as { model: unknown }).model, { harness: 'codex' })
  const schema = registry.createCoordinatorRegistry(OWNER, COORDINATOR_BOT, undefined, { coordinator: true }).dispatch_run.inputSchema as unknown as { safeParse: (value: unknown) => { success: boolean } }
  assert.equal(schema.safeParse({ issueId: ISSUE, repo: 'x', model: { harness: 'codex' } }).success, true)
  assert.equal(schema.safeParse({ issueId: ISSUE, repo: 'x', model: { harness: 'gemini' } }).success, false)
})

test('work that needs a screen goes to the Bot computer; everything else to an Agent, without asking which', async () => {
  const screen = await play('打开预览，看着前端登录流程的测试跑一遍', [
    { tool: 'wake_bot_computer', input: { botId: COORDINATOR_BOT } },
    { tool: 'dispatch_bot_computer', input: { botId: COORDINATOR_BOT, issueId: ISSUE, harness: 'claude_code' } },
  ], { computerEnabled: true })
  assert.match(screen.system, /work that needs a screen \(computer use, or watching a front-end flow or test run as it happens\) goes to your own computer/)
  assert.match(screen.system, /Decide this yourself; do not ask the person which/)
  assert.match(String(screen.tools.dispatch_bot_computer.description), /needs a screen/)
  assert.match(String(screen.tools.wake_bot_computer.description), /needs a screen/)
  assert.deepEqual(calls.map(call => call.step), ['wakeComputerBot', 'dispatchComputerThread'])

  calls.length = 0
  await play('修复 lib/foo.ts 的类型错误', [{ tool: 'dispatch_run', input: { issueId: ISSUE, repo: 'alexj11324/Mikka' } }], { computerEnabled: true })
  assert.deepEqual(calls.map(call => call.step), ['dispatchRun'])
})

test('standalone file work on the Bot computer has a repositoryless route for either subscribed Agent', async () => {
  for (const harness of ['claude_code', 'codex'] as const) {
    calls.length = 0
    const { system, tools } = await play('在你自己的云端电脑上创建一份纯文本交付，不需要 GitHub 仓库', [
      { tool: 'dispatch_bot_computer', input: { botId: COORDINATOR_BOT, issueId: ISSUE, harness } },
    ], { computerEnabled: true })
    assert.deepEqual(calls.map(call => call.step), ['dispatchComputerThread'])
    assert.deepEqual(calls[0].input, { botId: COORDINATOR_BOT, issueId: ISSUE, harness })
    assert.match(system, /standalone file or report.*dispatch_bot_computer/i)
    assert.doesNotMatch(system, /Everything else goes to an Agent with dispatch_run/)
    assert.match(String(tools.dispatch_bot_computer.description), /no repository/i)
    assert.doesNotMatch(String(tools.dispatch_bot_computer.description), /must be awake/i)
    assert.doesNotMatch(String(tools.dispatch_bot_computer.description), /Work that needs no screen goes to dispatch_run/)
    assert.match(String(tools.dispatch_run.description), /standalone file or report.*dispatch_bot_computer/i)
    assert.match(String(tools.dispatch_factory_task.description), /registered device repository/i)
    assert.match(String(tools.dispatch_factory_task.description), /dispatch_bot_computer/)
  }
})

test('no rule left that asks for what is already known', () => {
  const tools = registry.createCoordinatorRegistry(OWNER, COORDINATOR_BOT, undefined, { coordinator: true, computerEnabled: true })
  const text = [instructions, ...Object.values(tools).map(tool => String(tool.description ?? ''))].join('\n')
  for (const stale of [
    /if the workspace is ambiguous, ask the person/,
    /bind_bot_subscription only after the person selects/,
    /Only when the person has selected a connected subscription/,
    /make sure an agent and repository fit/,
    /Without a connected subscription the run uses Mikka's default model/,
  ]) assert.doesNotMatch(text, stale)
})

test('how to draw a card is said once, in the prompt; tools and events only point at it', async () => {
  const tools = registry.createCoordinatorRegistry(OWNER, COORDINATOR_BOT, undefined, { coordinator: true, computerEnabled: true })
  assert.match(instructions, /A card in a tool result or event .* is drawn as one BeQuestions choice question exactly as given/)
  for (const [name, entry] of Object.entries(tools)) assert.doesNotMatch(String(entry.description ?? ''), /each option keeps its value and action/, `${name} repeats the card recipe`)
  const { eventPrompt } = await import('./context')
  const offline = eventPrompt({ kind: 'run_finished', issueId: null, runId: 'run-1', payload: { status: 'failed', stopReason: 'machine', noMachine: { title: 't', options: [] } } })
  assert.match(offline, /Draw this card and dispatch the issue again/)
  assert.equal((instructions.match(/R-46/g) ?? []).length, 1, 'the secretary tone rule is stated once')
})

test('more work on a task goes to its thread; a new thread only when the person asked for one', async () => {
  const { system, tools } = await play('README 里再加一节安装说明', [{ tool: 'get_issue', input: { issueId: ISSUE } }, { tool: 'dispatch_run', input: { issueId: ISSUE, note: '再加一节安装说明' } }])
  assert.match(system, /To retry a task, or to give its thread more information, call dispatch_run .* for the same task again: it goes to the existing thread/)
  assert.match(system, /Never dispatch a second thread for it\. A new thread is needed when the person explicitly asked, in their own words/)
  assert.match(String(tools.dispatch_run.description), /A task has one thread at a time\. When the task already has one, this goes to that thread/)
  assert.match(system, /When it shows a thread, more work for the task goes to that thread: call dispatch_run without repo .* the thread keeps its repository, as long as the person has not named another one/)
  assert.match(String(tools.get_issue.description), /its thread \(runId, status, repository\)/)
  assert.deepEqual(calls.map(call => call.step), ['getIssue', 'dispatchRun'], 'no repository lookup for a task with a thread')
  const followUp = calls[1].input as { repo?: string; newThread?: boolean; note?: string }
  assert.deepEqual([followUp.repo, followUp.newThread, followUp.note], [undefined, undefined, '再加一节安装说明'], 'no repo and no new thread: the host keeps the thread and its repository')

  calls.length = 0
  await play('另开一个线程，用 Codex 重新做', [{ tool: 'dispatch_run', input: { issueId: ISSUE, repo: 'alexj11324/Mikka_test', newThread: true, model: { harness: 'codex' } } }])
  assert.equal((calls[0].input as { newThread?: boolean }).newThread, true, 'asked in the person\'s own words; the host still checks those words (lib/thread-switch.ts)')
})

// Alex's own words, from the Acme production thread (2026-11-03). Recorded turns: these check what the model is told
// and that what it should do reaches the host as it should; the live-model version is scripts/coordinator-eval.mts.
const MIKKA_SITE = 'On phones, the How it works section on the Mikka site is cut off. Can you fix it?'
const acmeCandidates = [
  { fullName: 'alexj11324/Mikka', description: 'Mikka app: bots, threads and the Coordinator', homepage: 'https://app.mikka.example', usedByThisWorkspace: true },
  { fullName: 'alexj11324/mikka-web', description: 'The Mikka marketing site', homepage: 'https://mikka.example', usedByThisWorkspace: false },
  { fullName: 'acme/mikka-enterprise', description: null, homepage: null, usedByThisWorkspace: false },
]

test(`「${MIKKA_SITE}」: every Mikka repository comes back described; the site goes to mikka-web, judged by description and homepage`, async () => {
  results.findRepository = { match: 'several', candidates: acmeCandidates, card: { title: '多个仓库匹配 Mikka site', options: acmeCandidates.map(item => ({ value: item.fullName, label: item.fullName })) } }
  const { system, tools } = await play(MIKKA_SITE, [
    { tool: 'find_repository', input: { name: 'Mikka site' } },
    { tool: 'dispatch_run', input: { issueId: ISSUE, repo: 'alexj11324/mikka-web' } },
  ])
  assert.match(system, /every word as they said it \(e\.g\. acme_tools, the Acme docs\)/)
  assert.match(system, /Choose by judging them against the person's own words \(a site, an app, a page or a product they named\), each repository's description and homepage, and the task/)
  assert.match(system, /When they still do not settle it, ask which repository/)
  assert.match(system, /Even when the result is one repository, check that it is the thing the person named/)
  assert.doesNotMatch(system, /Never pick one of several similar repositories yourself/, 'the model judges; it is not forbidden to')
  assert.match(String(tools.find_repository.description), /each with description, homepage and usedByThisWorkspace/)
  assert.deepEqual(calls.map(call => call.step), ['findRepository', 'dispatchRun'])
  assert.deepEqual(calls[0].input, { name: 'Mikka site' }, 'every word the person used reaches the lookup')
  assert.equal((calls[1].input as { repo: string }).repo, 'alexj11324/mikka-web')
})

test(`「${MIKKA_SITE}」 when the candidates do not settle it: one choice question, nothing dispatched`, async () => {
  results.findRepository = { match: 'several', candidates: acmeCandidates.map(item => ({ ...item, description: null, homepage: null })), card: { title: '多个仓库匹配 Mikka site', options: acmeCandidates.map(item => ({ value: item.fullName, label: item.fullName })) } }
  const { reply } = await play(MIKKA_SITE, [
    { tool: 'find_repository', input: { name: 'Mikka site' } },
    { text: '<BeQuestions>Mikka site 是哪个仓库？</BeQuestions>' },
  ])
  assert.deepEqual(calls.map(call => call.step), ['findRepository'])
  assert.match(reply, /BeQuestions/)
})

test('「It\'s in the mikka-web repo」 on a thread working in alexj11324/Mikka: the repository is passed, so the work moves to a new thread there', async () => {
  results.getIssue = { id: ISSUE, title: 'How it works is cut off on phones', thread: { runId: 'run-old', status: 'completed', repository: 'alexj11324/Mikka' } }
  results.dispatchRun = { runId: 'run-new', thread: 'new', threadId: 'run-new', replacedThreadId: 'run-old', placement: { kind: 'cloud' } }
  const { system, tools } = await play("It's in the mikka-web repo", [
    { tool: 'get_issue', input: { issueId: ISSUE } },
    { tool: 'dispatch_run', input: { issueId: ISSUE, repo: 'mikka-web' } },
    { text: '旧线程在 alexj11324/Mikka 上，已经停掉；改在 mikka-web 上开了新线程。' },
  ])
  assert.match(system, /and also when the repository or the Agent they name for the work is not the thread's own/)
  assert.match(system, /the thread keeps its repository, as long as the person has not named another one/)
  assert.match(system, /you tell the person that the old thread was stopped/)
  assert.doesNotMatch(system, /the thread already has its repository, so never look one up or ask the person for one/)
  assert.match(String(tools.dispatch_run.description), /pass repo only when the person named a repository that is not the thread's/)
  assert.deepEqual(calls.map(call => call.step), ['getIssue', 'dispatchRun'])
  assert.equal((calls[1].input as { repo?: string }).repo, 'mikka-web')
})

test(`screen work on a named site still names it to the sub-agent: 「${MIKKA_SITE}」 watched on a phone-sized browser`, async () => {
  const { system } = await play(`${MIKKA_SITE} Show me on a phone-sized browser first.`, [
    { tool: 'start_web_subagent', input: { botId: COORDINATOR_BOT, task: 'Open the Mikka site (repository alexj11324/mikka-web) at phone width and check the How it works section' } },
  ], { computerEnabled: true })
  assert.match(system, /do not look up a URL, a repository or a subscription first/, 'starting screen work stays immediate')
  assert.match(system, /When the person named a repository or a site, still pass it to the sub-agent or the thread/)
  assert.match((calls[0].input as { task: string }).task, /Mikka site/)
})

test('the prompt teaches judgment with neutral names; it never contains the eval\'s sentences or the real repositories', async () => {
  const tools = registry.createCoordinatorRegistry(OWNER, COORDINATOR_BOT, undefined, { coordinator: true, computerEnabled: true })
  const text = [instructions, ...Object.values(tools).map(tool => String(tool.description ?? '')), JSON.stringify(Object.fromEntries(await Promise.all(Object.entries(tools).map(async ([name, tool]) => [name, await asSchema(tool.inputSchema).jsonSchema]))))].join('\n')
  assert.match(text, /every word kept \(e\.g\. acme_tools, the Acme docs\)/, 'the parameter descriptions are read too')
  for (const leaked of [/Mikka site/i, /mikka-web/i, /mikka-enterprise/i, /How it works/i, /It's in the/i, /Mikka_test/, /alexj11324\/Mikka/i, /octo-web|octo-api/i, /landing page|docs site/i]) assert.doesNotMatch(text, leaked)
})

test('「Octo 官网的导航栏在手机上错位了」 with the authorized list in the turn: chosen from the list, no search needed', async () => {
  const { githubContext } = await import('./github-context')
  const listed = await githubContext(OWNER, {
    connection: async () => ({ githubLogin: 'octo-dev' }),
    list: async () => ({ login: 'octo-dev', installationAccounts: ['octo'], repositories: [
      { fullName: 'octo/octo', description: 'The product: app and API clients', homepage: 'https://app.octo.example', pushedAt: null },
      { fullName: 'octo/octo-web', description: 'The public marketing website', homepage: 'https://octo.example', pushedAt: null },
      { fullName: 'octo/octo-api', description: null, homepage: null, pushedAt: null },
    ] }),
  })
  assert.match(instructions, /The GitHub lines below list the repositories they authorized, each with its description and homepage: look there first/)
  assert.match(listed, /^- octo\/octo-web · "The public marketing website" · homepage "https:\/\/octo\.example"$/m)
  const { reply } = await play('Octo 官网的导航栏在手机上错位了，修一下', [
    { tool: 'dispatch_run', input: { issueId: ISSUE, repo: 'octo/octo-web' } },
    { text: '已经派给 Agent 在 octo/octo-web 上修。' },
  ])
  assert.deepEqual(calls.map(call => call.step), ['dispatchRun'], 'the list in the turn makes the lookup unnecessary')
  assert.equal((calls[0].input as { repo: string }).repo, 'octo/octo-web')
  assert.doesNotMatch(reply, /哪个仓库/)
})
