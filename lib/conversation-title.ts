/**
 * A conversation's stored title (decision 2026-11-13-1405): what moves it, and the SQL that keeps a person's rename.
 * Pure and client-safe; the model call is in conversation-title-server.ts.
 *
 * - `created`: a new conversation is named from what it was asked. A run that continues a conversation takes that
 *   conversation's title instead of asking the model again.
 * - `first_run_ended` and `pull_opened`: the conversation is named again once its real content is known (Capy's
 *   `titleTriggers`), only while its title is still a generated one.
 * - `regenerate`: the person asked for a new generated title; this is the one trigger that replaces a manual title.
 */
import { cleanShortTitle, isCjk } from './short-title'

export type ConversationTitleTrigger = 'created' | 'first_run_ended' | 'pull_opened' | 'regenerate'
export type ConversationTitleSource = 'generated' | 'manual'
type Stored = { title: string | null; titleSource: ConversationTitleSource | null }

export type ConversationTitlePlan = { do: 'keep' } | { do: 'copy'; title: string; source: ConversationTitleSource } | { do: 'generate' }

/**
 * What a trigger does, given the run's own stored title, the title its chain already carries (a manual one first)
 * and how many runs the chain has. Pure, so every trigger's rule is tested without a model or a database.
 */
export function conversationTitlePlan(trigger: ConversationTitleTrigger, run: Stored, chain: Stored, attempts: number): ConversationTitlePlan {
  if (trigger === 'regenerate') return { do: 'generate' }
  // A person's rename is the title: later runs of the conversation take it, and nothing generated replaces it.
  if (chain.titleSource === 'manual' && chain.title) return run.title === chain.title && run.titleSource === 'manual' ? { do: 'keep' } : { do: 'copy', title: chain.title, source: 'manual' }
  if (trigger === 'created') {
    if (run.title) return { do: 'keep' }
    return chain.title ? { do: 'copy', title: chain.title, source: 'generated' } : { do: 'generate' }
  }
  // The first run's end names the conversation once; a later run's end does not rename it.
  if (trigger === 'first_run_ended' && attempts !== 1) return { do: 'keep' }
  return { do: 'generate' }
}

/** A title a person typed, held to the stored bound; null when nothing usable is left. */
export function manualConversationTitle(raw: string): string | null {
  return cleanShortTitle(raw, isCjk(raw))
}

/**
 * Writes a title on every run of a conversation: $1 title, $2 source, $3 the chain's run ids, $4 owner, $5 whether a
 * manual title may be replaced (a rename or a regenerate the person asked for). Returns the runs that changed.
 */
export const WRITE_CONVERSATION_TITLE = `UPDATE agent_runs SET title=$1, "titleSource"=$2
  WHERE id=ANY($3::uuid[]) AND "userId"=$4 AND ($5::boolean OR "titleSource" IS DISTINCT FROM 'manual')
    AND (title IS DISTINCT FROM $1 OR "titleSource" IS DISTINCT FROM $2)
  RETURNING id`

/** The title a conversation already carries: a manual one first, else its newest generated one. $1 run ids, $2 owner. */
export const READ_CHAIN_TITLE = `SELECT title, "titleSource" FROM agent_runs WHERE id=ANY($1::uuid[]) AND "userId"=$2 AND title IS NOT NULL
  ORDER BY ("titleSource"='manual') DESC, "createdAt" DESC, id DESC LIMIT 1`
