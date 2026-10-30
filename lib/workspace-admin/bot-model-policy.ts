import { z } from 'zod'
import { WORKSPACE_BOT_MODELS, type WorkspaceBotModel } from '@/lib/db/schema'

/**
 * Bot settings rules shared by the server and the settings UI (docs/design/bot-settings.md).
 * No DB access here, so client components and unit tests can use it.
 *
 * Admins govern what is allowed: 可用模型 (an allowlist of model families) and,
 * optionally, the model a new bot starts with. Repositories are governed by the
 * workspace's GitHub App installations. Everything else is the bot owner's.
 */

/** A stored allowlist in menu order; null (never set) allows every family. Unknown values are dropped. */
export function allowedModelsOf(stored: readonly string[] | null | undefined): WorkspaceBotModel[] {
  if (!stored) return [...WORKSPACE_BOT_MODELS]
  return WORKSPACE_BOT_MODELS.filter(model => stored.includes(model))
}

/**
 * The model a bot runs on. Its own choice while that is allowed; otherwise the
 * workspace's starting model, otherwise the first allowed family. The stored
 * choice is never rewritten, so re-allowing a model brings it back.
 * `unavailable` is true when the owner's choice is set but no longer allowed.
 */
export function resolveBotModel(input: { model: string | null; allowedModels: readonly WorkspaceBotModel[]; startingModel: WorkspaceBotModel | null }): { model: WorkspaceBotModel | null; unavailable: boolean } {
  const allowed = (value: string | null): value is WorkspaceBotModel => value !== null && (input.allowedModels as readonly string[]).includes(value)
  if (allowed(input.model)) return { model: input.model, unavailable: false }
  const fallback = allowed(input.startingModel) ? input.startingModel : input.allowedModels[0] ?? null
  return { model: fallback, unavailable: input.model !== null }
}

/** A bot's repository counts only while the workspace's GitHub App installations still cover it. */
export function resolveBotRepository(repository: string | null, installed: readonly string[]): { repository: string | null; unavailable: boolean } {
  if (repository === null) return { repository: null, unavailable: false }
  return installed.includes(repository) ? { repository, unavailable: false } : { repository: null, unavailable: true }
}

const model = z.enum(WORKSPACE_BOT_MODELS)

/** 可用模型 plus the optional starting model. expectedVersion makes the save a compare-and-set. */
export const modelPolicyInput = z.object({
  allowedModels: z.array(model).min(1).max(WORKSPACE_BOT_MODELS.length).refine(list => new Set(list).size === list.length),
  startingModel: model.nullable(),
  /** Version the client last read; omitted = last write wins. */
  expectedVersion: z.number().int().min(0).optional(),
}).strict()

/** A bot's own settings. Omitted fields stay as they are; null clears. */
export const botSettingsInput = z.object({
  botId: z.string().uuid(),
  model: model.nullable().optional(),
  repository: z.string().trim().min(1).max(300).nullable().optional(),
}).strict()

export type SubscriptionProvider = 'codex' | 'claude'

/** Which provider a subscription binding route belongs to (byos_bindings.route). */
export function bindingProvider(route: string): SubscriptionProvider {
  return route.startsWith('claude') ? 'claude' : 'codex'
}

export type BotModelSource =
  | { family: WorkspaceBotModel; source: { type: 'subscription'; bindingId: string } | undefined }
  | { family: WorkspaceBotModel | null; refused: 'binding_required' | 'backend_unavailable' }

/**
 * What a bot's run actually uses, from its owner's choice and the workspace's 可用模型
 * (resolveBotModel). 'mikka' runs on Mikka's hosted model; Codex / Claude run on the
 * owner's own subscription binding for this bot, or the run is refused: a bot never
 * moves to another provider because a subscription is missing.
 * A bot whose owner never chose (`storedModel` null) keeps the subscription its
 * definition already selected, as long as that provider is allowed.
 */
export function chooseBotModelSource(input: {
  storedModel: WorkspaceBotModel | null
  allowedModels: readonly WorkspaceBotModel[]
  startingModel: WorkspaceBotModel | null
  /** The binding the bot's agent definition selected, if any. */
  definitionBinding: { id: string; provider: SubscriptionProvider } | null
  /** The owner's newest live binding for this bot, per provider. */
  latestBindings: Partial<Record<SubscriptionProvider, string>>
  /** Subscriptions can run in this deployment (BYOS and the agent kit are on). */
  subscriptionsRunnable: boolean
}): BotModelSource {
  const chosen = input.storedModel ?? input.definitionBinding?.provider ?? null
  const { model: family } = resolveBotModel({ model: chosen, allowedModels: input.allowedModels, startingModel: input.startingModel })
  if (family === null) return { family, refused: 'binding_required' }
  if (family === 'mikka') return { family, source: undefined }
  if (!input.subscriptionsRunnable) return { family, refused: 'backend_unavailable' }
  const bindingId = input.definitionBinding?.provider === family ? input.definitionBinding.id : input.latestBindings[family]
  return bindingId ? { family, source: { type: 'subscription', bindingId } } : { family, refused: 'binding_required' }
}

/** Families a bot can be set to here: allowed, and runnable in this deployment. */
export function selectableModels(allowedModels: readonly WorkspaceBotModel[], subscriptionsRunnable: boolean): WorkspaceBotModel[] {
  return allowedModels.filter(model => model === 'mikka' || subscriptionsRunnable)
}
