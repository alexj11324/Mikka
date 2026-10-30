'use server'

import type { ActionResult } from '@/lib/action-result'
import type { BotDefaultsView, BotModelId, BotThreadPage, WorkspaceBotRow } from '@/lib/settings/bots-api'
import { BOTS_MOCK_SCENARIOS, createMockBotsApi, type BotsMockScenario } from '@/lib/settings/bots-mock-data'

/**
 * DEV-ONLY server actions behind the settings harness. Each one refuses unless
 * the server runs with MIKKA_SETTINGS_HARNESS=1, and the mock data stays on the server.
 */
function mock(scenario: string) {
  if (process.env.MIKKA_SETTINGS_HARNESS !== '1') throw new Error('settings harness disabled')
  return createMockBotsApi((BOTS_MOCK_SCENARIOS as readonly string[]).includes(scenario) ? scenario as BotsMockScenario : 'default')
}

export async function mockGetBotDefaults(scenario: string): Promise<ActionResult<BotDefaultsView>> { return mock(scenario).getDefaults() }
export async function mockUpdateBotDefaults(scenario: string, input: { defaultModel?: BotModelId | null; defaultRepository?: string | null }): Promise<ActionResult<{ defaultModel: BotModelId | null; defaultRepository: string | null }>> { return mock(scenario).updateDefaults(input) }
export async function mockListBots(scenario: string): Promise<ActionResult<{ bots: WorkspaceBotRow[] }>> { return mock(scenario).listBots() }
export async function mockListBotThreads(scenario: string, input: { botId: string; limit?: number; cursor?: string | null }): Promise<ActionResult<BotThreadPage>> { return mock(scenario).listThreads(input) }
