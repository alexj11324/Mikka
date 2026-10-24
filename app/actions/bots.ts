'use server'

import { headers } from 'next/headers'
import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { bots } from '@/lib/db/schema'

/** A bot in the left column. Its instructions grow inside its chat, so they are not here. */
export interface BotView {
  id: string
  name: string
  color: string
  shape: string
}

const COLORS = ['encre', 'brun', 'rouge', 'orange', 'ambre', 'vert', 'turquoise', 'bleu', 'violet', 'rose', 'gris'] as const
const SHAPES = ['cercle', 'galet', 'squircle', 'capsule', 'triangle', 'hexagone', 'nuage', 'goutte'] as const

async function getUserId() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  return session.user.id
}

export async function listBots(): Promise<BotView[]> {
  const userId = await getUserId()
  return db.select({ id: bots.id, name: bots.name, color: bots.color, shape: bots.shape }).from(bots).where(eq(bots.userId, userId)).orderBy(asc(bots.createdAt))
}

/** 新建 Bot: a name, a colour and a shape. Bots run on Mikka's own harness, so there is no machine to pick. */
export async function createBot(input: { name: string; color: string; shape: string }): Promise<BotView> {
  const userId = await getUserId()
  const parsed = z.object({ name: z.string().trim().min(1).max(60), color: z.enum(COLORS), shape: z.enum(SHAPES) }).safeParse(input)
  if (!parsed.success) throw new ActionFailureError(parsed.error.issues[0]?.path[0] === 'name' ? 'validationNameRequired' : 'validationGeneric')
  const bot = { id: crypto.randomUUID(), ...parsed.data }
  try {
    await db.insert(bots).values({ ...bot, userId })
  } catch (error) {
    // 23505 is the per-person name index.
    if ((error as { code?: string }).code === '23505') throw new ActionFailureError('botDuplicateName')
    throw new ActionFailureError('validationGeneric')
  }
  return bot
}
