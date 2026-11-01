'use server'

import { headers } from 'next/headers'
import { z } from 'zod'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { auth } from '@/lib/auth'
import { desktopNotifyQuestions, readDesktopNotify, type DesktopCandidate } from '@/lib/platform/desktop-notifications'
import { listTaskRuns } from './task-runs'

const candidatesSchema = z.array(z.object({ id: z.string().max(300), issueId: z.string().max(100), kind: z.enum(['awaiting', 'failed', 'finished']) })).max(20)
const STATUS = { awaiting: 'waiting_input', failed: 'failed', finished: 'succeeded' } as const

/**
 * Which run transitions the desktop app shows as system notifications: the
 * Decisions API decides (lib/platform/desktop-notifications.ts). Only the
 * signed-in person's own runs, in the state the candidate names, are judged.
 */
export async function chooseDesktopNotifications(raw: unknown): Promise<ActionResult<{ show: string[] }>> {
  return runAction(async () => {
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.user) throw new ActionFailureError('authRequired')
    const parsed = candidatesSchema.safeParse(raw)
    if (!parsed.success || !parsed.data.length) return { show: [] }
    const runs = new Map((await listTaskRuns()).map(run => [run.issueId, run]))
    const candidates: DesktopCandidate[] = parsed.data.flatMap(item => {
      const run = runs.get(item.issueId)
      return run && run.status === STATUS[item.kind] ? [{ id: item.id, kind: item.kind, title: run.issueTitle, agent: run.agentName }] : []
    })
    if (!candidates.length) return { show: [] }
    const userId = session.user.id
    const [{ decide }, { hostedBillingScope }, { executionWorkspace }] = await Promise.all([import('@/lib/coordinator/decide'), import('@/lib/abuse/context'), import('@/lib/execution-settings')])
    let answers = null
    try { answers = await hostedBillingScope.run({ workspaceId: await executionWorkspace(userId, null), ownerId: userId }, () => decide('desktop-notify', candidates.map(candidate => `${candidate.id}: ${candidate.kind}`).join('\n'), desktopNotifyQuestions(candidates))) } catch { answers = null }
    return { show: readDesktopNotify(answers, candidates) }
  })
}
