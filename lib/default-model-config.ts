import { gatewayLiteLlm } from './model-gateway/config'

type Env = Record<string, string | undefined>

/** Configuration readiness without making a model request. */
export function defaultModelConfigured(env: Env = process.env): boolean {
  return gatewayLiteLlm(env) !== null
}
