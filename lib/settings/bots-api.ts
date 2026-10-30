import type { ActionResult } from '@/lib/action-result'

/**
 * 设置 › Bot (V13 / WS-05~07) client contract.
 *
 * Shapes mirror #434 (listBotThreads, modelGroups) and the #431 base actions
 * (getWorkspaceBotDefaults, updateWorkspaceBotDefaults, listWorkspaceBots).
 * The page only talks to a BotsSettingsApi, so swapping the mock in
 * bots-mock.ts for the real server actions is a one-line change once #434 lands.
 */
export type BotModelId = 'mikka' | 'codex' | 'claude'

export interface BotModelGroup { id: BotModelId; source: 'hosted' | 'subscription'; labelKey: `Settings.bots.models.${BotModelId}`; isDefault: boolean }

export interface BotDefaultsView {
  defaultModel: BotModelId | null
  defaultRepository: string | null
  models: readonly BotModelId[]
  repositories: string[]
  /** #434: Mikka 默认 / Codex / Claude in menu order. */
  modelGroups: readonly BotModelGroup[]
}

export interface WorkspaceBotRow {
  id: string; name: string; color: string; shape: string
  ownerId: string; ownerName: string | null
  model: BotModelId | null; repository: string | null
  status: 'idle' | 'running'; runningThreads: number
}

export interface BotThreadRow {
  threadId: string
  initiator: { id: string; name: string | null; avatarUrl: string | null }
  title: string | null
  status: 'running' | 'done'
  lastActivityAt: string
  canOpen: boolean
  href: string | null
}

export interface BotThreadPage {
  bot: { id: string; name: string }
  summary: { totalThreads: number; lastActivityAt: string | null }
  threads: BotThreadRow[]
  nextCursor: string | null
}

export interface BotsSettingsApi {
  /** Admins may change 新 Bot 默认值; members see the disabled default state. */
  isAdmin: boolean
  getDefaults(): Promise<ActionResult<BotDefaultsView>>
  updateDefaults(input: { defaultModel?: BotModelId | null; defaultRepository?: string | null }): Promise<ActionResult<{ defaultModel: BotModelId | null; defaultRepository: string | null }>>
  listBots(): Promise<ActionResult<{ bots: WorkspaceBotRow[] }>>
  listThreads(input: { botId: string; limit?: number; cursor?: string | null }): Promise<ActionResult<BotThreadPage>>
}

export const BOT_MODEL_GROUPS: readonly BotModelGroup[] = (['mikka', 'codex', 'claude'] as const).map(id => ({
  id, source: id === 'mikka' ? 'hosted' : 'subscription', labelKey: `Settings.bots.models.${id}` as const, isDefault: id === 'mikka',
}))

/** The value a Select shows: a stored null means the default group. */
export function effectiveModel(defaults: Pick<BotDefaultsView, 'defaultModel' | 'modelGroups'>): BotModelId {
  return defaults.defaultModel ?? defaults.modelGroups.find(group => group.isDefault)?.id ?? 'mikka'
}
