import { afterDatabaseCommit } from './db/commit-effects'
export { wakeTokens } from './workflow-wake-tokens'

/**
 * Wakes a durable workflow that waits on `createHook({ token })` instead of
 * re-reading the database on a timer (#1212). A wake is a hint: the workflow
 * re-reads its rows, and still wakes on its own slow fallback if one is lost.
 *
 * Sent only where workflows run: on Vercel, with an explicit
 * WORKFLOW_TARGET_WORLD, or under `next dev`. Unit and database tests send
 * none (resumeHook would start a local world there); the workflow's fallback
 * timer is then its only wake.
 */
export function workflowWakesEnabled(env: Record<string, string | undefined> = process.env) {
  return Boolean(wakeTransport.resume || env.VERCEL || env.WORKFLOW_TARGET_WORLD || env.NODE_ENV === 'development')
}

/** What a wake carries: nothing, or the deployment that sent it (lib/due-timer.ts, #1410). */
export type WakePayload = { deploymentId?: string }

/** Tests replace resumeHook here to observe wakes without a Workflow world. */
export const wakeTransport: { resume?: (token: string, payload: WakePayload) => Promise<unknown> } = {}

/** Best effort, now. A token nobody holds (the workflow ended, or never waited) is not an error. */
export async function wakeWorkflow(token: string, resume?: (token: string, payload: WakePayload) => Promise<unknown>) {
  try {
    const resumeHook = resume ?? wakeTransport.resume ?? (await import('workflow/api')).resumeHook
    await resumeHook(token, {})
  } catch { /* no workflow waiting on this token */ }
}

/** wakeWorkflow after the current request, for a write that has already committed. */
export function wakeWorkflowSoon(token: string) {
  if (!workflowWakesEnabled()) return
  void import('./background').then(({ afterJob }) => afterJob('after:workflow-wake', () => wakeWorkflow(token), { orRun: true })).catch(() => {})
}

/** wakeWorkflow once this transaction commits; nothing on rollback. Never fails the write. */
export function wakeWorkflowAfterCommit(executor: object, token: string) {
  if (!workflowWakesEnabled()) return
  try {
    afterDatabaseCommit(executor, `workflow-wake:${token}`, async () => {
      const { afterJob } = await import('./background')
      afterJob('after:workflow-wake', () => wakeWorkflow(token), { orRun: true })
    })
  } catch { /* an executor without commit tracking: the workflow's fallback timer covers it */ }
}

