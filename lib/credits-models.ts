import 'server-only'
import { isCloudEdition } from './edition'
import { COORDINATOR_MODEL } from './coordinator/model'
import { catalogModel, CATALOG_SNAPSHOT, type CatalogModel } from './model-catalog'

/**
 * The models Mikka 额度 runs here (decision 2026-11-15-1900). Mikka Cloud:
 * the whole Gateway catalogue. A self-hosted server: the one model its own
 * provider or connected Mikka Cloud serves for chats, under its internal id.
 */
export async function creditsModels(ownerId?: string): Promise<CatalogModel[]> {
  if (isCloudEdition()) return (await import('./model-catalog-server')).modelCatalog()
  if (!(await (await import('./default-model')).defaultModelTarget(ownerId))) return []
  return [catalogModel(COORDINATOR_MODEL, CATALOG_SNAPSHOT) ?? { id: COORDINATOR_MODEL, vendor: 'deepseek', name: COORDINATOR_MODEL,
    contextWindow: null, maxTokens: null, pricing: null, tags: [], reasoning: [] }]
}

/** Whether a Mikka 额度 pick names a model this server offers. */
export async function creditsModelOffered(model: string, ownerId?: string): Promise<boolean> {
  return (await creditsModels(ownerId)).some(item => item.id === model)
}
