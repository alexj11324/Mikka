import assert from 'node:assert/strict'
import test from 'node:test'
import { acceptanceBot, observeChunks, parseOptions, runCloudStartup } from './cloud-startup.mjs'

const args = ['--origin', 'https://app.aspectlylabs.com', '--mode', 'canary', '--runs', '1', '--harness', 'claude_code', '--strategy', 'official', '--output', 'report.json']

test('canary accepts the workflow arguments without relaxing baseline batch size', () => {
  const options = parseOptions(args, {})
  assert.equal(options.mode, 'canary')
  assert.equal(options.runs, 1)
  assert.equal(options.output, 'report.json')
  assert.throws(() => parseOptions(['--runs', '1'], {}), /startup_runs_invalid/)
  for (const extra of [['--harness', 'both'], ['--runs', '0'], ['--runs', '2']]) {
    assert.throws(() => parseOptions([...args, ...extra], {}), /startup_option_invalid/)
  }
})

test('canary rejects missing account credentials before dispatch', async () => {
  await assert.rejects(runCloudStartup(parseOptions(args, {}), {
    env: {}, fetchImpl: () => assert.fail('must not dispatch'),
  }), /startup_smoke_account_required/)
})

test('a second canary invocation reuses the owned workspace bot instead of creating another', async () => {
  const bots = [], calls = []
  const client = {
    async rpc(action, args) {
      calls.push(action)
      if (action === 'bots.listBots') return bots
      assert.equal(action, 'bots.createBot')
      const bot = { id: '00000000-0000-4000-8000-000000000001', ...args[0] }
      bots.push(bot)
      return bot
    },
    async json(path) {
      return bots.find(bot => path === `/api/bots/${bot.id}`)
    },
  }
  const first = await acceptanceBot(client, undefined, 'first-run', { mode: 'canary' })
  const second = await acceptanceBot(client, undefined, 'second-run', { mode: 'canary' })
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(second.botId, first.botId)
  assert.equal(second.retention, 'retained_reusable_canary')
  assert.equal(bots.length, 1)
  assert.equal(calls.filter(action => action === 'bots.createBot').length, 1)
})

test('canary refuses a failed, malformed or ambiguous bot listing without creating a bot', async () => {
  for (const list of [null, [{ id: 'bad', name: '测试1505 cloud-run-canary' }],
    [{ name: '测试1505 cloud-run-canary' }, { name: '测试1505 cloud-run-canary' }]]) {
    await assert.rejects(acceptanceBot({ rpc: async action => {
      assert.equal(action, 'bots.listBots')
      return list
    } }, undefined, 'run', { mode: 'canary' }), /startup_(response_invalid|bot_invalid|test_bot_required)/)
  }
  await assert.rejects(acceptanceBot({ rpc: async action => {
    assert.equal(action, 'bots.listBots')
    throw Error('listing unavailable')
  } }, undefined, 'run', { mode: 'canary' }), /listing unavailable/)
})

function execution(status = 'succeeded') {
  const at = '2026-11-21T00:00:00.000Z'
  const record = { sampleId: 'canary', runId: 'canary-run', requireReply: true,
    minToolCalls: 1, requireReplyAfterTool: true, requireTerminal: true, requireSuccess: true }
  const chunk = value => ({ at, chunk: value })
  const detail = { thread: { id: record.runId, status }, chunks: [
    chunk({ type: 'data-run-stage', data: { stage: 'agent_start', ms: 1, ok: true } }),
    chunk({ type: 'tool-input-available', toolCallId: 'read', toolName: 'mcp__mikka__inspect_artifact', input: { path: 'README.md' } }),
    chunk({ type: 'tool-output-available', toolCallId: 'read', output: 'read' }),
    chunk({ type: 'text-delta', delta: 'STARTUP_OK_canary' }),
  ] }
  return { record, detail }
}

test('canary execution proof requires successful completion after a read and reply', () => {
  const { record, detail } = execution()
  assert.equal(observeChunks(record, detail, Date.now()), true)
  assert.equal(record.replyVerifiedAfterTool, true)
  for (const status of ['running', 'failed', 'stopped', 'cancelled']) {
    const current = execution(status)
    assert.equal(observeChunks(current.record, current.detail, Date.now()), false, status)
  }
})

test('empty output and failed tools cannot prove canary execution', () => {
  const empty = execution()
  empty.detail.chunks = []
  assert.equal(observeChunks(empty.record, empty.detail, Date.now()), false)
  const failed = execution()
  failed.detail.chunks[2].chunk = { type: 'tool-output-error', toolCallId: 'read', errorText: 'failed' }
  assert.equal(observeChunks(failed.record, failed.detail, Date.now()), false)
})
