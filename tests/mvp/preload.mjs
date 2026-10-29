import { createGateway } from 'ai'
import { assertMvpEnvironment, MVP_SERVICES } from './isolated-env.mjs'
import { installMvpTransport } from './transport.mjs'

assertMvpEnvironment()
// The supported AI SDK provider boundary keeps Mikka's WorkflowAgent and all
// durable/tool execution intact. Never import this preload in application code.
globalThis.AI_SDK_DEFAULT_PROVIDER = createGateway({ baseURL: `${MVP_SERVICES}/v1`, apiKey: 'mvp-synthetic-gateway' })
installMvpTransport()
