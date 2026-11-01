import assert from 'node:assert/strict'
import test from 'node:test'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { generateText, Output } from 'ai'
import { z } from 'zod'
import { groupReplySystemPrompt } from './group-reply-prompt'

test('group structured output satisfies the DeepSeek JSON-mode prompt contract', async () => {
  let requests = 0
  const expected = { text: 'Received', mentions: [], privateTo: null }
  const provider = createOpenAICompatible({ name: 'contract-deepseek', baseURL: 'https://deepseek.invalid/v1', apiKey: 'synthetic-contract-test', fetch: async (input, init) => {
    const request = new Request(input, init)
    const body = await request.json()
    requests++
    assert.equal(body.response_format.type, 'json_object')
    assert.ok(body.messages.some((message: { content?: unknown }) => typeof message.content === 'string' && /json/i.test(message.content)), 'DeepSeek refuses json_object without JSON in a prompt message')
    return Response.json({ id: 'synthetic-group', object: 'chat.completion', created: 1, model: 'deepseek-flash', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(expected) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
  } })
  const result = await generateText({ model: provider.chatModel('deepseek-flash'), system: groupReplySystemPrompt({ name: 'Peer', description: 'Reviewer' }), prompt: 'Read the peer message.', output: Output.object({ schema: z.object({ text: z.string(), mentions: z.array(z.string().uuid()), privateTo: z.string().uuid().nullable() }) }), maxRetries: 0 })
  assert.deepEqual(result.output, expected)
  assert.equal(requests, 1)
})
