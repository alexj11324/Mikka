import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText, jsonSchema, stepCountIs, streamText, tool } from 'ai'
import { createLiteLLMModel, liteLLMCost, liteLLMGenerationId } from '../../lib/model-gateway/litellm-client.ts'
import { localModelAnswer } from '../../scripts/dev-local/model.mjs'
import { FAKE_LITELLM_KEY, FAKE_MODEL_KEY, startFakeLiteLlm } from './litellm.mjs'
import { eventPrompt } from '../../lib/coordinator/context.ts'
import { personalPeerText, presentPersonalInboxRow } from '../../lib/personal-mailbox-presentation.ts'

test('the production LiteLLM client preserves streamed and nonstreamed billing receipts over real HTTP', async t => {
  const server = await startFakeLiteLlm({ answer: localModelAnswer })
  t.after(() => server.close())
  const previous = { MIKKA_LITELLM_URL: process.env.MIKKA_LITELLM_URL, MIKKA_LITELLM_MASTER_KEY: process.env.MIKKA_LITELLM_MASTER_KEY }
  process.env.MIKKA_LITELLM_URL = server.url
  process.env.MIKKA_LITELLM_MASTER_KEY = FAKE_LITELLM_KEY
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  const model = createLiteLLMModel('mikka-default')
  const response = await generateText({ model, prompt: '/echo receipt', maxRetries: 0 })
  assert.equal(response.text, 'Local model: receipt')
  assert.equal(liteLLMCost(response.providerMetadata), 1234)
  assert.match(liteLLMGenerationId(response.providerMetadata), /^fake-litellm-/)
  const streamed = streamText({ model, prompt: '/echo streamed receipt', maxRetries: 0 })
  assert.equal(await streamed.text, 'Local model: streamed receipt')
  assert.equal(liteLLMCost(await streamed.providerMetadata), 1234)
  assert.equal((await streamed.usage).inputTokens, 11)
  const ownKey = createLiteLLMModel('deepseek-flash', { credential: { provider: 'openai', modelId: 'deepseek-flash', apiKey: FAKE_MODEL_KEY, baseUrl: 'https://never-contacted.invalid/v1' } })
  assert.equal((await generateText({ model: ownKey, prompt: '/echo placeholder BYOK', maxRetries: 0 })).text, 'Local model: placeholder BYOK')
  await assert.rejects(generateText({ model, prompt: 'unregistered request', maxRetries: 0 }), error => error.statusCode === 422)
})

test('the real Responses SDK parses fragmented tool arguments and executes the registered tool exactly once', async t => {
  const server = await startFakeLiteLlm({ answer: localModelAnswer })
  t.after(() => server.close())
  const model = createOpenAI({ baseURL: `${server.url}/v1`, apiKey: FAKE_LITELLM_KEY }).responses('mikka-default')
  const calls = []
  const result = streamText({ model, prompt: '/tool echo {"word":"actual response SDK"}', maxRetries: 0, stopWhen: stepCountIs(2),
    tools: { echo: tool({ inputSchema: jsonSchema({ type: 'object', properties: { word: { type: 'string' } }, required: ['word'], additionalProperties: false }), execute: async input => { calls.push(input); return { echoed: input.word } } }) },
  })
  assert.equal(await result.text, 'echo: {"echoed":"actual response SDK"}')
  assert.deepEqual(calls, [{ word: 'actual response SDK' }])
  assert.deepEqual((await result.steps).map(step => step.usage.outputTokens), [7, 7])
  assert.equal((await result.totalUsage).outputTokens, 14)
})

test('the daemon installed Messages SDK preserves fragmented tool input and its correlated result', async t => {
  const server = await startFakeLiteLlm({ answer: localModelAnswer })
  t.after(() => server.close())
  const daemonRequire = createRequire(new URL('../../packages/daemon/package.json', import.meta.url))
  const sdkRequire = createRequire(daemonRequire.resolve('@anthropic-ai/claude-agent-sdk'))
  const { default: Anthropic } = sdkRequire('@anthropic-ai/sdk')
  const client = new Anthropic({ baseURL: server.url, apiKey: FAKE_MODEL_KEY, maxRetries: 0,
    defaultHeaders: { 'x-litellm-api-key': `Bearer ${FAKE_LITELLM_KEY}` },
  })
  const calls = []
  const options = { model: 'mikka-default', max_tokens: 100, messages: [{ role: 'user', content: '/tool echo {"word":"actual messages SDK"}' }],
    tools: [{ name: 'echo', input_schema: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'], additionalProperties: false } }],
  }
  const first = await client.messages.stream(options).finalMessage()
  assert.equal(first.stop_reason, 'tool_use')
  const call = first.content.find(part => part.type === 'tool_use')
  assert.equal(call.name, 'echo')
  calls.push(call.input)
  const next = await client.messages.stream({ ...options, messages: [...options.messages,
    { role: 'assistant', content: first.content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify({ echoed: call.input.word }) }] },
  ] }).finalMessage()
  assert.equal(next.content.find(part => part.type === 'text').text, 'echo: {"echoed":"actual messages SDK"}')
  assert.deepEqual(calls, [{ word: 'actual messages SDK' }])
  assert.deepEqual([first.usage.output_tokens, next.usage.output_tokens], [7, 7])
  assert.equal(first.usage.input_tokens + next.usage.input_tokens, 22)
})

test('the actual product peer notification drives mailbox tools through LiteLLM and the SDK', async t => {
  const server = await startFakeLiteLlm({ answer: localModelAnswer })
  t.after(() => server.close())
  const marker = 'mailbox-00000000-0000-4000-8000-000000000001'
  const key = '00000000-0000-4000-8000-000000000002'
  const id = '00000000-0000-4000-8000-000000000003'
  const senderMailboxId = '00000000-0000-4000-8000-000000000004'
  const notice = eventPrompt({ kind: 'run_report', issueId: null, runId: null, payload: { text: personalPeerText({ id, senderMailboxId,
    text: 'A new personal mailbox message is waiting. Read mailbox_inbox at the next safe boundary. Reading does not ACK.' }) } })
  const calls = []
  const registration = (name, result) => tool({ inputSchema: jsonSchema({ type: 'object', additionalProperties: true }), execute: async input => { calls.push({ name, input }); return result } })
  const model = createOpenAI({ baseURL: `${server.url}/v1`, apiKey: FAKE_LITELLM_KEY }).chat('mikka-default')
  const response = streamText({ model, maxRetries: 0, stopWhen: stepCountIs(6), prompt: notice,
    system: `If an incoming envelope body contains REQUEST ${marker}, send exactly one reply to its senderMailboxId, key ${key}, text REPLY ${marker}, replyTo its ID. Then ACK it.`,
    tools: {
      mailbox_recipients: registration('mailbox_recipients', {}),
      mailbox_inbox: registration('mailbox_inbox', { messages: [presentPersonalInboxRow({ id, senderMailboxId, text: `REQUEST ${marker}`, origin: 'peer', acknowledgedAt: null })] }),
      mailbox_send: registration('mailbox_send', { id: 'actual-test-tool-receipt', queued: true, duplicate: false }),
      mailbox_ack: registration('mailbox_ack', { acknowledged: [id] }),
      mailbox_sent: registration('mailbox_sent', []),
    },
  })
  assert.equal(await response.text, 'Mailbox handling completed from actual inbox and ACK receipts.')
  assert.deepEqual(calls.map(call => call.name), ['mailbox_inbox', 'mailbox_send', 'mailbox_ack', 'mailbox_sent'])
  assert.deepEqual(calls[1].input, { to: senderMailboxId, key, text: `REPLY ${marker}`, replyTo: id })
  assert.deepEqual(calls[2].input, { ids: [id] })
})
