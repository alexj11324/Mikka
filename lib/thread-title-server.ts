import 'server-only'
import { withConversationWorkspace } from './conversation-workspace'
import { causeFields } from '@mikka/protocol/coded-error'
import { pool } from '@/lib/db'
import { defaultModelAvailable } from '@/lib/default-model'
import { runListChanged } from '@/lib/live/lists'
import { readRuntimeSetting } from '@/lib/settings/runtime'
import { readRunChain } from '@/lib/run-chain'
import { threadTitlePlan, effectiveTitleSettings, manualThreadTitle, READ_CHAIN_TITLE, READ_TITLE_SETTINGS, titleTriggerAllows, WRITE_THREAD_TITLE, type ThreadTitleSettingRow, type ThreadTitleSource, type ThreadTitleTrigger } from './thread-title'

type Query = { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }
type Generate = (ownerId: string, text: { title: string; body: string }, workspaceId: string, naming?: readonly string[]) => Promise<string | null>

/**
 * What the model names a thread from: only the recorded task range of its prompt (lib/run-bot-name.ts; never
 * the execution instructions around it), what the run reported, and the title of a PR it delivered. $1 run, $2 owner.
 */
const READ_RUN = `SELECT r."userId", r."workspaceId", r.title, r."titleSource",
    left(ltrim(case when r."promptTaskStart">=0 and r."promptTaskLength" between 0 and length(r.prompt)-r."promptTaskStart"::int8 then substr(r.prompt,r."promptTaskStart"+1,r."promptTaskLength") else '' end, E' \\t\\r\\n'), 1200) AS asked,
    left(coalesce(r.report->>'summary',''), 800) AS summary
  FROM agent_runs r WHERE r.id=$1 AND r."userId"=$2
    AND r."workspaceId"=$3`
const READ_PULL_REQUEST = `SELECT p."pullRequest"->>'title' AS title FROM run_publications p WHERE p."runId"=ANY($1::uuid[]) AND p."pullRequest"->>'title' IS NOT NULL ORDER BY p."updatedAt" DESC LIMIT 1`

async function chainOf(database: Query, ownerId: string, runId: string) {
  const chain = await readRunChain(database, ownerId, runId)
  return chain ? chain.attempts.map(attempt => attempt.runId) : [runId]
}

async function write(database: Query, ownerId: string, workspaceId: string, runIds: string[], title: string, source: ThreadTitleSource, overManual: boolean, observedManual?: string | null) {
  const { rows } = await database.query(WRITE_THREAD_TITLE, [title, source, runIds, ownerId, overManual, observedManual !== undefined, observedManual ?? null, workspaceId])
  return rows.length > 0
}

/**
 * Names one thread for a trigger (thread-title.ts). Runs after the response, never on a render path; a
 * thread with no usable prompt, an unavailable model or a refused admission keeps its bounded fallback.
 * Returns the title it wrote, or null. `generate` is the shared small-model call (short-title-server.ts).
 */
export async function nameThread(database: Query, runId: string, ownerId: string, trigger: ThreadTitleTrigger, generate: Generate): Promise<string | null> {
  // Discover only the immutable tenant before reading the prompt or publication.
  const tenant = (await database.query('SELECT "workspaceId" FROM agent_runs WHERE id=$1 AND "userId"=$2', [runId, ownerId])).rows[0]?.workspaceId
  if (typeof tenant !== 'string') return null
  const input = await withConversationWorkspace(ownerId, tenant, async () => {
    const run = (await database.query(READ_RUN, [runId, ownerId, tenant])).rows[0] as { title: string | null; titleSource: ThreadTitleSource | null; asked: string; summary: string } | undefined
    if (!run) return null
    // Capy's "Thread titles" settings: the workspace's and the member's instructions, and when a title is written again.
    const settings = effectiveTitleSettings((await database.query(READ_TITLE_SETTINGS, [tenant, ownerId])).rows as ThreadTitleSettingRow[], ownerId)
    if (!titleTriggerAllows(trigger, settings.triggers)) return null
    const runIds = await chainOf(database, ownerId, runId)
    const chain = ((await database.query(READ_CHAIN_TITLE, [runIds, ownerId])).rows[0] ?? { title: null, titleSource: null }) as { title: string | null; titleSource: ThreadTitleSource | null }
    const protection = await readRuntimeSetting(database, 'protectManualThreadTitles', { userId: ownerId, workspaceId: tenant })
    const plan = threadTitlePlan(trigger, run, chain, runIds.length, protection.value)
    if (plan.do === 'keep') return null
    if (plan.do === 'copy') {
      const changed = await write(database, ownerId, tenant, runIds, plan.title, plan.source, plan.source === 'manual',
        plan.source === 'manual' ? plan.title : undefined)
      return { kind: 'copied' as const, title: changed ? plan.title : null }
    }
    const [first = '', ...rest] = run.asked.split('\n').map(line => line.trim()).filter(Boolean)
    if (!first) return null
    const pullRequest = trigger === 'created' ? undefined : (await database.query(READ_PULL_REQUEST, [runIds])).rows[0] as { title: string } | undefined
    const body = [rest.join('\n'), trigger === 'created' ? '' : run.summary, pullRequest?.title ? `Pull request: ${pullRequest.title}` : ''].filter(Boolean).join('\n\n')
    return { kind: 'generate' as const, first, body, chain, runIds, naming: settings.instructions, protectManual: protection.value }
  })
  if (!input || input.kind === 'copied') return input?.title ?? null
  // The model runs outside the membership lock. Re-admit before persisting its result.
  const title = await generate(ownerId, { title: input.first, body: input.body }, tenant, input.naming)
  if (!title) return null
  const changed = await withConversationWorkspace(ownerId, tenant, async () => {
    const protection = await readRuntimeSetting(database, 'protectManualThreadTitles', { userId: ownerId, workspaceId: tenant })
    // A protection change during generation must not authorize overwriting a manual title.
    const mayReplaceManual = trigger === 'regenerate' || (!input.protectManual && !protection.value)
    return write(database, ownerId, tenant, input.runIds, title, 'generated', mayReplaceManual,
      input.chain.titleSource === 'manual' ? input.chain.title : null)
  })
  return changed ? title : null
}

/** The background job behind scheduleThreadTitle. Never throws. */
export async function writeThreadTitle(runId: string, ownerId: string, trigger: ThreadTitleTrigger): Promise<void> {
  try {
    if (!await defaultModelAvailable(ownerId)) return
    const { generateShortTitle } = await import('./short-title-server')
    if (await nameThread(pool, runId, ownerId, trigger, generateShortTitle)) await runListChanged(pool, runId)
  } catch (error) {
    // By name and code only: a failed query's message carries its parameters, which hold the prompt.
    console.error('Thread title failed', JSON.stringify(causeFields(error)))
  }
}

/** A person renames the thread: every run of it takes the title, and nothing generated replaces it. */
export async function renameThreadTitle(database: Query, runId: string, ownerId: string, raw: string, workspaceId: string): Promise<string | null> {
  const title = manualThreadTitle(raw)
  if (!title) return null
  return withConversationWorkspace(ownerId, workspaceId, async () => {
    const keys = [runId, ownerId, workspaceId]
    const authorized = 'SELECT title,"titleSource" FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "workspaceId"=$3'
    if (!(await database.query(authorized, keys)).rows.length) return null
    const runIds = await chainOf(database, ownerId, runId)
    if (await write(database, ownerId, workspaceId, runIds, title, 'manual', true)) return title
    const current = (await database.query(authorized, keys)).rows[0]
    return current?.title === title && current.titleSource === 'manual' ? title : null
  })
}
