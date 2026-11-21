import 'server-only'
import { isCloudEdition } from './edition'
import { SELF_HOSTED_DEFAULT_CATALOG_ID } from './model-gateway/config'
import type { CatalogModel } from './model-catalog'

/**
 * The models Mikka 额度 runs here (decision 2026-11-15-1900). Mikka Cloud:
 * the configured LiteLLM catalogue. A self-hosted server offers its default
 * LiteLLM alias.
 */
export async function creditsModels(ownerId?: string): Promise<CatalogModel[]> {
  if (isCloudEdition()) return (await import('./model-catalog-server')).modelCatalog()
  if (!(await (await import('./default-model')).defaultModelTarget(ownerId))) return []
  return [{ id: SELF_HOSTED_DEFAULT_CATALOG_ID, vendor: 'mikka', name: SELF_HOSTED_DEFAULT_CATALOG_ID,
    contextWindow: null, maxTokens: null, pricing: null, tags: [], reasoning: [] }]
}

/** Whether a Mikka 额度 pick names a model this server offers. */
export async function creditsModelOffered(model: string, ownerId?: string): Promise<boolean> {
  return (await creditsModels(ownerId)).some(item => item.id === model)
}
