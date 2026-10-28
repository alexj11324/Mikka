import { createGateway } from 'ai'
import { assertMvpEnvironment, MVP_SERVICES } from './isolated-env.mjs'

assertMvpEnvironment()
// The supported AI SDK provider boundary keeps Mikka's WorkflowAgent and all
// durable/tool execution intact. Never import this preload in application code.
globalThis.AI_SDK_DEFAULT_PROVIDER = createGateway({ baseURL: `${MVP_SERVICES}/v1`, apiKey: 'mvp-synthetic-gateway' })
const originalFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init)
  const url = new URL(request.url)
  if (url.origin === 'https://api.github.com') {
    return originalFetch(new Request(`${MVP_SERVICES}/github${url.pathname}${url.search}`, request), input instanceof Request ? init : undefined)
  }
  // Unconfigured external credentials must never turn a deterministic CI run
  // into a live provider call. Workflow, app and fixture HTTP remain loopback.
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('MVP fixture refused an unstubbed external request')
  return originalFetch(input, init)
}
