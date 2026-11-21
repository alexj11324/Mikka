'use server'

import { createHash, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { telegramConversations, telegramLinkTokens, telegramLinks } from '@/lib/db/schema'
import { readTelegramIntegrationStatus } from '@/lib/telegram/connection-status'
import { requireUser } from '@/lib/issue-access'

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
const botUsername = () => process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, '')

export async function getTelegramIntegrationStatus() {
  return readTelegramIntegrationStatus((await requireUser()).id)
}

export async function createTelegramConnectLink() {
  const user = await requireUser()
  const username = botUsername()
  if (!username || !process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN) return { error: 'notConfigured' as const }
  const token = randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000)
  await db.insert(telegramLinkTokens).values({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
  }).onConflictDoUpdate({
    target: telegramLinkTokens.userId,
    set: { tokenHash: hashToken(token), expiresAt, createdAt: new Date() },
  })
  return { link: 'https://t.me/' + username + '?start=' + token, expiresAt: expiresAt.toISOString() }
}

export async function disconnectTelegram() {
  const user = await requireUser()
  await db.transaction(async tx => {
    await tx.delete(telegramConversations).where(eq(telegramConversations.userId, user.id))
    await tx.delete(telegramLinkTokens).where(eq(telegramLinkTokens.userId, user.id))
    await tx.delete(telegramLinks).where(eq(telegramLinks.userId, user.id))
  })
  return { success: true as const }
}
