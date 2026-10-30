import type { ActionResult } from '@/lib/action-result'
import { BOT_MODEL_GROUPS, type BotDefaultsView, type BotThreadPage, type BotThreadRow, type BotsSettingsApi, type WorkspaceBotRow } from '@/lib/settings/bots-api'

/**
 * MOCK — shapes copied from #434 (listBotThreads, getWorkspaceBotDefaults.modelGroups). Dev harness and tests only;
 * production code must pass the real server actions.
 */
export type BotsMockScenario = 'default' | 'member' | 'empty' | 'error' | 'loading' | 'saveError'

const minutesAgo = (now: number, minutes: number) => new Date(now - minutes * 60_000).toISOString()

export function mockBotThreads(now = Date.now()): BotThreadRow[] {
  const alex = { id: 'u_alex', name: 'Alex', avatarUrl: null }
  return [
    { threadId: 't_' + '1'.repeat(32), initiator: alex, title: 'Fix the OAuth callback on the sign-in page', status: 'running', lastActivityAt: minutesAgo(now, 12), canOpen: true, href: '/?issue=demo-1' },
    { threadId: 't_' + '2'.repeat(32), initiator: alex, title: 'Move settings to the v4 layout', status: 'done', lastActivityAt: minutesAgo(now, 60), canOpen: true, href: '/?issue=demo-2' },
    { threadId: 't_' + '3'.repeat(32), initiator: alex, title: 'Summarize October usage', status: 'done', lastActivityAt: minutesAgo(now, 26 * 60), canOpen: true, href: '/?issue=demo-3' },
    { threadId: 't_' + '4'.repeat(32), initiator: { id: 'u_mia', name: 'Mia', avatarUrl: null }, title: null, status: 'done', lastActivityAt: minutesAgo(now, 120), canOpen: false, href: null },
  ]
}

export const MOCK_BOTS: WorkspaceBotRow[] = [
  { id: '00000000-0000-4000-8000-000000000001', name: 'Coordinator', color: 'encre', shape: 'cercle', ownerId: 'u_alex', ownerName: 'Alex', model: null, repository: null, status: 'idle', runningThreads: 0 },
  { id: '00000000-0000-4000-8000-000000000002', name: 'Frontend', color: 'vert', shape: 'squircle', ownerId: 'u_alex', ownerName: 'Alex', model: 'codex', repository: 'alexj11324/mikka', status: 'running', runningThreads: 2 },
  { id: '00000000-0000-4000-8000-000000000003', name: 'Research', color: 'vert', shape: 'hexagone', ownerId: 'u_mia', ownerName: 'Mia', model: null, repository: null, status: 'idle', runningThreads: 0 },
]

const never = <T,>() => new Promise<T>(() => {})

export function createMockBotsApi(scenario: BotsMockScenario = 'default', now = Date.now()): BotsSettingsApi {
  const defaults: BotDefaultsView = {
    defaultModel: null, defaultRepository: 'alexj11324/mikka', models: ['mikka', 'codex', 'claude'],
    repositories: ['alexj11324/mikka', 'alexj11324/mikka-desktop', 'alexj11324/mikka-docs'], modelGroups: BOT_MODEL_GROUPS,
  }
  const fail = { error: 'generic' } as const
  return {
    isAdmin: scenario !== 'member',
    async getDefaults() {
      if (scenario === 'loading') return never()
      if (scenario === 'error') return fail
      return { ...defaults }
    },
    async updateDefaults(input) {
      if (scenario === 'saveError') return fail
      if (input.defaultModel !== undefined) defaults.defaultModel = input.defaultModel
      if (input.defaultRepository !== undefined) defaults.defaultRepository = input.defaultRepository
      return { defaultModel: defaults.defaultModel, defaultRepository: defaults.defaultRepository }
    },
    async listBots() {
      if (scenario === 'loading') return never()
      if (scenario === 'error') return fail
      return { bots: scenario === 'empty' ? [] : MOCK_BOTS }
    },
    async listThreads({ botId }): Promise<ActionResult<BotThreadPage>> {
      const bot = MOCK_BOTS.find(row => row.id === botId)
      if (!bot) return { error: 'validationGeneric' }
      const threads = bot.name === 'Research' ? [] : mockBotThreads(now)
      return { bot: { id: bot.id, name: bot.name }, summary: { totalThreads: threads.length, lastActivityAt: threads[0]?.lastActivityAt ?? null }, threads, nextCursor: null }
    },
  }
}
