import 'server-only'
import { gatewayLiteLlm } from './model-gateway/config'
import { CATALOG_SNAPSHOT, FEATURED_MODELS, parseGatewayModel, type CatalogModel } from './model-catalog'

const CATALOG_PATH = '/v1/mikka/catalog'
const TTL_MS = 24 * 60 * 60 * 1000
const FAILED_RETRY_MS = 10 * 60 * 1000

let cached: { at: number; models: CatalogModel[]; live: boolean } | null = null
let pending: Promise<CatalogModel[]> | null = null

/**
 * The catalogue Mikka 额度 can run: the Gateway's language models with tool
 * use, featured ones first. Read on demand and kept for a day; when the
 * Gateway cannot be reached the featured snapshot stands in (a failed read is
 * retried after ten minutes, on the next request that needs it).
 */
export async function modelCatalog(fetcher: typeof fetch = fetch, now = Date.now()): Promise<CatalogModel[]> {
  if (cached && now - cached.at < (cached.live ? TTL_MS : FAILED_RETRY_MS)) return cached.models
  return pending ??= read(fetcher, now).finally(() => { pending = null })
}

async function read(fetcher: typeof fetch, now: number): Promise<CatalogModel[]> {
  try {
    const config = gatewayLiteLlm()
    if (!config) throw new Error('litellm_not_configured')
    const response = await fetcher(config.url + CATALOG_PATH, {
      signal: AbortSignal.timeout(5000),
      headers: { accept: 'application/json', authorization: 'Bearer ' + config.masterKey },
      redirect: 'error',
    })
    if (!response.ok) throw new Error(`gateway_models_${response.status}`)
    const body = await response.json() as { data?: unknown[] }
    const models = (Array.isArray(body.data) ? body.data : []).map(parseGatewayModel).filter((model): model is CatalogModel => model !== null)
    if (!models.length) throw new Error('gateway_models_empty')
    cached = { at: now, models: featuredFirst(models), live: true }
  } catch (error) {
    console.warn('model catalog read failed', { name: error instanceof Error ? error.name : typeof error, code: error instanceof Error ? error.message : undefined })
    cached = { at: now, models: [...(cached?.live ? cached.models : CATALOG_SNAPSHOT)], live: false }
  }
  return cached.models
}

function featuredFirst(models: CatalogModel[]): CatalogModel[] {
  const rank = new Map<string, number>(FEATURED_MODELS.map((id, at) => [id, at]))
  return models.map((model, at) => ({ model, at })).sort((a, b) =>
    (rank.get(a.model.id) ?? Infinity) - (rank.get(b.model.id) ?? Infinity) || a.at - b.at).map(({ model }) => model)
}

/** Tests only: forget the cached read. */
export function resetModelCatalogForTests() { cached = null; pending = null }
