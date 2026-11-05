import { createHook, sleep, type Hook } from 'workflow'

/** Wakes whoever holds `token` (lib/workflow-wake.ts), from inside a workflow. */
export async function nudgeWorkflow(token: string) {
  'use step'
  const { wakeWorkflow } = await import('@/lib/workflow-wake')
  await wakeWorkflow(token)
}

const never = new Promise<never>(() => {})

/**
 * In workflow code: waits until a writer wakes `token` (lib/workflow-wake.ts)
 * or until the epoch ms `at`, whichever comes first (#1212). Wakes that land
 * while the workflow is busy are kept by the hook and end the next wait at once.
 *
 * One execution holds a token at a time. A second execution for the same row
 * (a duplicate start, a newer question wake) finds it held: it nudges the
 * holder to re-check and waits on its timer only, trying to take the token
 * again on its next wait.
 */
export function workflowWakes(token: string) {
  let hook: Hook<unknown> | null = null
  return async function until(at: number) {
    if (!hook) {
      const candidate = createHook<unknown>({ token })
      const conflict = await candidate.getConflict().then(run => run !== null, () => true)
      if (conflict) { candidate.dispose(); await nudgeWorkflow(token) } else hook = candidate
    }
    await Promise.race([hook ?? never, sleep(new Date(Math.max(at, Date.now() + 1_000)))])
  }
}
