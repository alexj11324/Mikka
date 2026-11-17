import 'server-only'
import type { Pool } from 'pg'
import { defaultAgentCopy } from './agent-copy'
import { BOT_AGENTS, type BotAgent } from './db/schema'

/**
 * The Agent a Bot's tasks run on (decision 2026-11-17): the one the Bot names,
 * never a default. A Bot made before the choice existed names none; its
 * dispatch is refused with botAgentRequired and the card below.
 */
export async function botAgent(query: Pick<Pool, 'query'>, botId: string): Promise<BotAgent | null> {
  const { rows: [row] } = await query.query<{ agent: string | null }>('SELECT agent FROM bots WHERE id=$1', [botId])
  return (BOT_AGENTS as readonly (string | null | undefined)[]).includes(row?.agent) ? row!.agent as BotAgent : null
}

/** 请先为这个 Bot 选择 Agent: its one row opens the Bot's settings (the right panel of its chat). */
export function botAgentRequiredCard(botId: string) {
  const copy = defaultAgentCopy
  return { title: copy.botAgentTitle, description: copy.botAgentDescription,
    options: [{ value: botId, label: copy.botAgentSettings, action: 'botSettings' as const }] }
}

/** The refusal every Bot dispatch returns when the Bot names no Agent; nothing is queued. */
export function botAgentRequired(botId: string, issueId?: string) {
  return { error: 'machineUnavailable' as const, reason: 'botAgentRequired' as const, ...(issueId ? { issueId } : {}), card: botAgentRequiredCard(botId) }
}
