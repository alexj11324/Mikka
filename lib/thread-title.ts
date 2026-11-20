/**
 * A thread's stored title (decision 2026-11-13-1405): what moves it, and the SQL that keeps a person's rename.
 * Pure and client-safe; the model call is in thread-title-server.ts.
 *
 * - `created`: a new thread is named from what it was asked. A run that continues a thread takes that
 *   thread's title instead of asking the model again.
 * - `first_run_ended` and `pull_opened`: the thread is named again once its real content is known (Capy's
 *   `titleTriggers`), only while its title is still a generated one.
 * - `regenerate`: the person asked for a new generated title; this is the one trigger that replaces a manual title.
 */
import { cleanShortTitle, isCjk } from './short-title'

export type ThreadTitleTrigger = 'created' | 'first_run_ended' | 'pull_opened' | 'regenerate'
/** Capy's "Regenerate the title when": the first message is finished, a pull request opens, or either. */
export type ThreadTitleTriggers = 'first_run_ended' | 'pull_opened' | 'either'
export const THREAD_TITLE_TRIGGERS: readonly ThreadTitleTriggers[] = ['first_run_ended', 'pull_opened', 'either']
export const DEFAULT_TITLE_TRIGGERS: ThreadTitleTriggers = 'either'
export const TITLE_INSTRUCTIONS_MAX = 1000

/** A workspace's row (`userId` '') and the member's own, as stored. */
export type ThreadTitleSettingRow = { userId: string; instructions: string; triggers: ThreadTitleTriggers | null }

/** The settings that apply to a member: the workspace's instructions, then theirs; their triggers, else the workspace's. */
export function effectiveTitleSettings(rows: readonly ThreadTitleSettingRow[], userId: string) {
  const workspace = rows.find(row => row.userId === '')
  const own = rows.find(row => row.userId === userId && userId !== '')
  return {
    instructions: [workspace?.instructions ?? '', own?.instructions ?? ''].map(text => text.trim()).filter(Boolean),
    triggers: own?.triggers ?? workspace?.triggers ?? DEFAULT_TITLE_TRIGGERS,
  }
}

/** Whether a trigger names the thread under these settings. Creation and a person's Regenerate always do. */
export function titleTriggerAllows(trigger: ThreadTitleTrigger, triggers: ThreadTitleTriggers) {
  if (trigger === 'created' || trigger === 'regenerate') return true
  return triggers === 'either' || triggers === trigger
}

/** $1 workspace, $2 member. */
export const READ_TITLE_SETTINGS = `SELECT "userId", instructions, triggers FROM thread_title_settings WHERE "workspaceId"=$1 AND "userId" IN ('', $2)`
export type ThreadTitleSource = 'generated' | 'manual'
type Stored = { title: string | null; titleSource: ThreadTitleSource | null }

export type ThreadTitlePlan = { do: 'keep' } | { do: 'copy'; title: string; source: ThreadTitleSource } | { do: 'generate' }

/**
 * What a trigger does, given the run's own stored title, the title its chain already carries (a manual one first)
 * and how many runs the chain has. Pure, so every trigger's rule is tested without a model or a database.
 */
export function threadTitlePlan(trigger: ThreadTitleTrigger, run: Stored, chain: Stored, attempts: number, protectManual = true): ThreadTitlePlan {
  if (trigger === 'regenerate') return { do: 'generate' }
  // A person's rename is the title: later runs of the thread take it, and nothing generated replaces it.
  if (chain.titleSource === 'manual' && chain.title && (protectManual || trigger === 'created')) return run.title === chain.title && run.titleSource === 'manual' ? { do: 'keep' } : { do: 'copy', title: chain.title, source: 'manual' }
  if (trigger === 'created') {
    if (run.title) return { do: 'keep' }
    return chain.title ? { do: 'copy', title: chain.title, source: 'generated' } : { do: 'generate' }
  }
  // The first run's end names the thread once; a later run's end does not rename it.
  if (trigger === 'first_run_ended' && attempts !== 1) return { do: 'keep' }
  return { do: 'generate' }
}

/** A title a person typed, held to the stored bound; null when nothing usable is left. */
export function manualThreadTitle(raw: string): string | null {
  return cleanShortTitle(raw, isCjk(raw))
}

/**
 * Writes a title on every run of a thread: $1 title, $2 source, $3 the chain's run ids, $4 owner, $5 whether a
 * manual title may be replaced, $6 whether this is a regeneration, $7 the manual title observed before generation, $8 the admitted workspace.
 */
export const WRITE_THREAD_TITLE = `UPDATE agent_runs SET title=$1, "titleSource"=$2
  WHERE id=ANY($3::uuid[]) AND "userId"=$4 AND ("titleSource" IS DISTINCT FROM 'manual' OR ($5::boolean AND (NOT $6::boolean OR title IS NOT DISTINCT FROM $7::text)))
    AND "workspaceId"=$8
    AND (title IS DISTINCT FROM $1 OR "titleSource" IS DISTINCT FROM $2)
  RETURNING id`

/** The title a thread already carries: a manual one first, else its newest generated one. $1 run ids, $2 owner. */
export const READ_CHAIN_TITLE = `SELECT title, "titleSource" FROM agent_runs WHERE id=ANY($1::uuid[]) AND "userId"=$2 AND title IS NOT NULL
  ORDER BY ("titleSource"='manual') DESC, "createdAt" DESC, id DESC LIMIT 1`
