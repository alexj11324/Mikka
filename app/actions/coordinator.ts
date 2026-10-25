'use server'

import { headers } from 'next/headers'
import { after } from 'next/server'
import { z } from 'zod'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { userMessageEvent } from '@/lib/coordinator-events'
import { chatView, type ChatView } from '@/lib/coordinator/store'
import { QUOTE_TEXT_MAX, withQuote, type ArtifactQuote } from '@/lib/artifacts/quote'
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

const quoteSchema = z.object({
  artifactId: z.uuid(), version: z.number().int().min(1), kind: z.enum(['text', 'element']),
  text: z.string().trim().min(1).max(QUOTE_TEXT_MAX), label: z.string().max(200).optional(), selector: z.string().max(1000).optional(),
})

/** Sends a message to the Coordinator, with a quote from an artifact in front if given; its reply shows up in the chat. */
export async function sendCoordinatorMessage(text: string, quote?: ArtifactQuote | null): Promise<ActionResult<{ queued: true }>> {
  return runAction(async () => {
    const userId = await getUserId()
    const parsed = z.string().trim().min(1).max(10_000).safeParse(text)
    if (!parsed.success) throw new ActionFailureError('messageRequired')
    const quoted = quote ? quoteSchema.safeParse(quote) : null
    if (quoted && !quoted.success) throw new ActionFailureError('messageRequired')
    await recordCoordinatorEvent(db, userMessageEvent(userId, withQuote(parsed.data, quoted?.data)))
    after(() => wakeCoordinator(userId))
    return { queued: true as const }
  })
}
