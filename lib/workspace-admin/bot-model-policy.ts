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
