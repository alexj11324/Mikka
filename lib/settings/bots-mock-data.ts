import type { ActionResult } from '@/lib/action-result'
import { BOT_MODEL_GROUPS, type BotDefaultsView, type BotThreadPage, type BotThreadRow, type BotsSettingsApi, type WorkspaceBotRow } from '@/lib/settings/bots-api'

/**
 * MOCK — shapes copied from #434 (listBotThreads, getWorkspaceBotDefaults.modelGroups).
 * Server-side only: reached through the gated server actions in bots-mock-actions.ts
 * (and unit tests), so none of this copy ships in public client chunks.
 */
export const BOTS_MOCK_SCENARIOS = ['default', 'member', 'empty', 'error', 'loading', 'saveError', 'saveRace', 'moreError'] as const
export type BotsMockScenario = (typeof BOTS_MOCK_SCENARIOS)[number]

/** saveRace: a Codex save waits this long and then fails; any other save succeeds at once. */
export const SAVE_RACE_DELAY_MS = 800
export const THREAD_PAGE_SIZE = 20

const minutesAgo = (now: number, minutes: number) => new Date(now - minutes * 60_000).toISOString()
const hex = (n: number) => n.toString(16).padStart(32, '0')
const alex = { id: 'u_alex', name: 'Alex', avatarUrl: null }
const mia = { id: 'u_mia', name: 'Mia', avatarUrl: null }

export const MOCK_BOTS: WorkspaceBotRow[] = [
  { id: '00000000-0000-4000-8000-000000000001', name: 'Coordinator', color: 'encre', shape: 'cercle', ownerId: 'u_alex', ownerName: 'Alex', model: null, repository: null, status: 'idle', runningThreads: 0 },
  { id: '00000000-0000-4000-8000-000000000002', name: 'Frontend', color: 'vert', shape: 'squircle', ownerId: 'u_alex', ownerName: 'Alex', model: 'codex', repository: 'alexj11324/mikka', status: 'running', runningThreads: 2 },
  { id: '00000000-0000-4000-8000-000000000003', name: 'Research', color: 'vert', shape: 'hexagone', ownerId: 'u_mia', ownerName: 'Mia', model: null, repository: null, status: 'idle', runningThreads: 0 },
]

/** Every thread of a bot, newest first. Idle bots have no running threads; Frontend has exactly its 2 running plus enough history for a second page. */
export function mockBotThreads(botName: string, now = Date.now()): BotThreadRow[] {
  if (botName === 'Coordinator') return [
    { threadId: 't_' + hex(1), initiator: alex, title: 'Summarize October usage', status: 'done', lastActivityAt: minutesAgo(now, 60), canOpen: true, href: '/?issue=demo-3' },
    { threadId: 't_' + hex(2), initiator: mia, title: null, status: 'done', lastActivityAt: minutesAgo(now, 120), canOpen: false, href: null },
    { threadId: 't_' + hex(3), initiator: alex, title: 'Plan the settings v4 rollout', status: 'done', lastActivityAt: minutesAgo(now, 26 * 60), canOpen: true, href: '/?issue=demo-4' },
  ]
  if (botName === 'Frontend') return [
    { threadId: 't_' + hex(10), initiator: alex, title: 'Fix the OAuth callback on the sign-in page', status: 'running', lastActivityAt: minutesAgo(now, 12), canOpen: true, href: '/?issue=demo-1' },
    { threadId: 't_' + hex(11), initiator: alex, title: 'Move settings to the v4 layout', status: 'running', lastActivityAt: minutesAgo(now, 30), canOpen: true, href: '/?issue=demo-2' },
    ...Array.from({ length: 23 }, (_, i): BotThreadRow => i % 5 === 2
      ? { threadId: 't_' + hex(20 + i), initiator: mia, title: null, status: 'done', lastActivityAt: minutesAgo(now, 90 * (i + 1)), canOpen: false, href: null }
      : { threadId: 't_' + hex(20 + i), initiator: alex, title: `Review pull request ${400 + i}`, status: 'done', lastActivityAt: minutesAgo(now, 90 * (i + 1)), canOpen: true, href: `/?issue=demo-${10 + i}` }),
  ]
  return []
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Data side of the mock. `loading` is handled by the client wrapper (it never resolves there). */
export function createMockBotsApi(scenario: BotsMockScenario = 'default', now = Date.now()): BotsSettingsApi {
  const defaults: BotDefaultsView = {
    defaultModel: null, defaultRepository: 'alexj11324/mikka', models: ['mikka', 'codex', 'claude'],
    repositories: ['alexj11324/mikka', 'alexj11324/mikka-desktop', 'alexj11324/mikka-docs'], modelGroups: BOT_MODEL_GROUPS,
  }
  const fail = { error: 'generic' } as const
  return {
    isAdmin: scenario !== 'member',
    async getDefaults() {
      if (scenario === 'error') return fail
      return { ...defaults }
    },
    async updateDefaults(input) {
      if (scenario === 'saveError') return fail
      if (scenario === 'saveRace' && input.defaultModel === 'codex') { await sleep(SAVE_RACE_DELAY_MS); return fail }
      if (input.defaultModel !== undefined) defaults.defaultModel = input.defaultModel
      if (input.defaultRepository !== undefined) defaults.defaultRepository = input.defaultRepository
      return { defaultModel: defaults.defaultModel, defaultRepository: defaults.defaultRepository }
    },
    async listBots() {
      if (scenario === 'error') return fail
      return { bots: scenario === 'empty' ? [] : MOCK_BOTS }
    },
    async listThreads({ botId, limit = THREAD_PAGE_SIZE, cursor }): Promise<ActionResult<BotThreadPage>> {
      const bot = MOCK_BOTS.find(row => row.id === botId)
      if (!bot) return { error: 'validationGeneric' }
      if (cursor && scenario === 'moreError') return fail
      const all = mockBotThreads(bot.name, now)
      const start = cursor ? Math.max(0, all.findIndex(row => row.threadId === cursor) + 1) : 0
      const threads = all.slice(start, start + limit)
      const more = start + limit < all.length
      return { bot: { id: bot.id, name: bot.name }, summary: { totalThreads: all.length, lastActivityAt: all[0]?.lastActivityAt ?? null }, threads, nextCursor: more ? threads.at(-1)!.threadId : null }
    },
  }
}
