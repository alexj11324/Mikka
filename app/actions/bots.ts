'use server'

import { headers } from 'next/headers'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { auth } from '@/lib/auth'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { db } from '@/lib/db'
import { bots } from '@/lib/db/schema'
import { BOT_COLORS, BOT_SHAPES } from '@/lib/bot-shapes'

/** A bot in the left column. Its instructions grow inside its chat, so they are not here. */
export interface BotView {
  id: string
  name: string
  color: string
  shape: string
}


/** The person and the workspace they are in: a bot belongs to both. */
async function getOwner() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  const context = await loadWorkspaceContext(undefined, session.user)
  return { ownerId: session.user.id, workspaceId: context.workspace.id }
}

export async function listBots(): Promise<BotView[]> {
  const { ownerId, workspaceId } = await getOwner()
  return db.select({ id: bots.id, name: bots.name, color: bots.color, shape: bots.shape }).from(bots)
    .where(and(eq(bots.ownerId, ownerId), eq(bots.workspaceId, workspaceId))).orderBy(asc(bots.createdAt))
}

/** 新建 Bot: a name, a colour and a shape. Bots run on Mikka's own harness, so there is no machine to pick. */
export async function createBot(input: { name: string; color: string; shape: string }): Promise<BotView> {
  const owner = await getOwner()
  const parsed = z.object({ name: z.string().trim().min(1).max(60), color: z.enum(BOT_COLORS), shape: z.enum(BOT_SHAPES) }).safeParse(input)
  if (!parsed.success) throw new ActionFailureError(parsed.error.issues[0]?.path[0] === 'name' ? 'validationNameRequired' : 'validationGeneric')
  const bot = { id: crypto.randomUUID(), ...parsed.data }
  try {
    await db.insert(bots).values({ ...bot, ...owner })
  } catch (error) {
    // 23505 is the per-person, per-workspace name index.
    if ((error as { code?: string }).code === '23505') throw new ActionFailureError('botDuplicateName')
    throw new ActionFailureError('validationGeneric')
  }
  return bot
}
