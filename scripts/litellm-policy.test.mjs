import assert from 'node:assert/strict'
import test from 'node:test'
import { auditLiteLlmSource } from './litellm-policy.mjs'

test('rejects a direct model request and renamed SDK factories outside the LiteLLM client', () => {
  for (const source of [
    `fetch('https://api.openai.com/v1/responses')`,
    `fetch(\`https://api.cloudflare.com/client/v4/accounts/\${account}/ai/v1/chat/completions\`)`,
    `createOpenAICompatible({ baseURL: endpoint, apiKey })`,
    `gateway('model')`,
    `import { createOpenAI as provider } from '@ai-sdk/openai'; provider({ baseURL: endpoint })`,
    `import Direct from 'openai'; new Direct({ apiKey })`,
    `generateText({ model: 'openai/gpt-6-luna', prompt })`,
    `import { openai } from '@ai-sdk/openai'; openai('model')`,
    `const provider = await import('@ai-sdk/openai')`,
    `import { gateway as provider } from 'ai'; provider('model')`,
  ]) assert.ok(auditLiteLlmSource('lib/model-call.ts', source).length, source)
})

test('permits only the designated client, ordinary gateway methods, and subscription metadata', () => {
  assert.deepEqual(auditLiteLlmSource('lib/model-gateway/litellm-client.ts', `createOpenAI({ baseURL: url })`), [])
  assert.deepEqual(auditLiteLlmSource('lib/model-call.ts', `modelAdmission.gateway(scope, model)`), [])
  assert.deepEqual(auditLiteLlmSource('lib/model-call.ts', `import { GatewayError } from '@ai-sdk/gateway'`), [])
  assert.deepEqual(auditLiteLlmSource('packages/daemon/src/quota/claude.ts', `const url = 'https://api.anthropic.com/api/oauth/usage'`), [])
  assert.ok(auditLiteLlmSource('packages/daemon/src/quota/claude.ts', `createAnthropic({})`).length)
})
