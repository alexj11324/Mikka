import 'server-only'
import { defaultModelConfigured } from './default-model-config'

export type DefaultModelTarget = { kind: 'hosted' }

/** Every installation uses its administrator-configured LiteLLM service. */
export async function defaultModelTarget(_ownerId?: string): Promise<DefaultModelTarget | null> {
  return defaultModelConfigured() ? { kind: 'hosted' } : null
}

export const defaultModelAvailable = async (ownerId?: string) => (await defaultModelTarget(ownerId)) !== null
