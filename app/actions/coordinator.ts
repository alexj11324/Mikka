'use server'

import {selectedScheduleWorkspace} from '@/lib/schedules/runtime'
import {workspaceDb} from '@/lib/workspace-db'
import {requireWorkspace,WorkspaceError} from '@/lib/workspace-access'
import { cookies, headers } from 'next/headers'
import { after } from 'next/server'
import { z } from 'zod'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { auth } from '@/lib/auth'
import { recordUserSubmission } from '@/lib/coordinator-event-store'
import { chatView, type ChatView } from '@/lib/coordinator/store'
import { coordinatorEnabled, wakeCoordinator } from '@/lib/coordinator/wake'

async function getUserId(): Promise<string> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  return session.user.id
}

export type CoordinatorChat = ChatView & { enabled: boolean }

/** The person's chat with their Coordinator. */
export async function getCoordinatorChat(): Promise<CoordinatorChat> {
  const userId = await getUserId()
  const enabled = coordinatorEnabled()
  const chat = await chatView(userId)
  // Without a Coordinator here nothing is coming, so do not show one working.
  return { ...chat, enabled, working: enabled && chat.working }
}

/** Sends a message to the Coordinator; its reply shows up in the chat. */
export async function sendCoordinatorMessage(text: string): Promise<ActionResult<{ queued: true }>> {
  return runAction(async () => {
    const requestHeaders=await headers()
    const session=await auth.api.getSession({headers:requestHeaders,query:{disableCookieCache:true}})
    if(!session?.user)throw new ActionFailureError('authRequired')
    const userId=session.user.id
    const parsed = z.string().trim().min(1).max(10_000).safeParse(text)
    if (!parsed.success) throw new ActionFailureError('messageRequired')
    const selected=(await cookies()).get('mikka-workspace')?.value
    if(selected&&!z.uuid().safeParse(selected).success)throw new ActionFailureError('workspaceAccessDenied')
    const workspaceId=selected??await selectedScheduleWorkspace(userId)
    if(!workspaceId)throw new ActionFailureError('workspaceAccessDenied')
    try{await workspaceDb.transaction(tx=>requireWorkspace(tx,workspaceId,userId))}
    catch(error){if(error instanceof WorkspaceError)throw new ActionFailureError('workspaceAccessDenied');throw error}
    await recordUserSubmission(userId,parsed.data,undefined,{workspaceId,
      ...(!requestHeaders.has('authorization')&&requestHeaders.get('cookie')?{humanSessionId:session.session.id}:{})})
    after(() => wakeCoordinator(userId))
    return { queued: true as const }
  })
}
