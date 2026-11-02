import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { generateText, stepCountIs, type ToolSet } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'

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
const step = (name: string, result: unknown = { ok: true }) => async (...args: unknown[]) => { calls.push({ step: name, input: args[1] }); return result }
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
  const { executionContextText } = await import('./execution-context')
  const github = await githubContext(OWNER, {
    connection: async () => ({ githubLogin: 'alexj11324' }),
    list: async () => ({ login: 'alexj11324', installationAccounts: ['alexj11324'], repositories: Array.from({ length: 50 }, (_, index) => index) }),
  })
  const execution = executionContextText({
    workspace: { name: 'Alex', kind: 'personal' },
    devices: [{ name: 'Alex 的 MacBook', online: true, enabled: true, agents: ['Claude Code', 'Codex'] }],
    order: { location: 'local', entries: [{ agent: 'Claude Code', model: 'opus', provider: 'anthropic', block: null }, { agent: 'Codex', model: 'gpt-codex', provider: 'openai', block: null }], credentials: [{ kind: 'subscription', provider: 'anthropic' }, { kind: 'subscription', provider: 'openai' }] },
    e2b: false,
    hosted: 'points_exhausted',
  })
  systemPrompt = async () => `${instructions}\n${github}\n${execution}`
})
beforeEach(() => { calls.length = 0; process.env.MIKKA_ISSUE_TOOLS_ENABLED = '1' })

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
