import 'server-only'
import { isCloudEdition } from './edition'
import { defaultModelConfigured, selfHostedDefaultModelConfig } from './default-model-config'

export type DefaultModelTarget =
  | { kind: 'cloud'; serviceUrl: string }
  | { kind: 'self-hosted' }
  | { kind: 'hosted' }

/** One selection order for bot defaults, titles and background work. This only
 * reads this installation's binding; it never refreshes a token or calls cloud. */
export async function defaultModelTarget(ownerId?: string): Promise<DefaultModelTarget | null> {
  if (isCloudEdition()) return defaultModelConfigured() ? { kind: 'hosted' } : null
  if (ownerId) {
    const { cloudClient } = await import('./cloud-services/runtime')
    const connected = await cloudClient.capability(ownerId, 'models')
    if (connected) return { kind: 'cloud', ...connected }
  }
  if (selfHostedDefaultModelConfig()) return { kind: 'self-hosted' }
  // Explicit gateway/ZeroCat configuration remains usable without Mikka Cloud.
  return defaultModelConfigured() ? { kind: 'hosted' } : null
}

export const defaultModelAvailable = async (ownerId?: string) => (await defaultModelTarget(ownerId)) !== null

/** Only models authorization selects the cloud Decision endpoint. The caller
 * then checks its own DECISIONS_URL/key, or leaves Decisions unavailable. */
export async function cloudDecisionTarget(ownerId?: string): Promise<{ serviceUrl: string } | null> {
  if (isCloudEdition() || !ownerId) return null
  return (await import('./cloud-services/runtime')).cloudClient.capability(ownerId, 'models')
}
