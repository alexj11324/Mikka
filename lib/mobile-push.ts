import 'server-only'
import { eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { bots, mobilePushTokens } from '@/lib/db/schema'
import { readPreferences } from '@/lib/preferences'
import { pushAllowed } from '@/lib/push-allowed'
import type { PushReason } from '@/lib/push-reasons'
import { chatMuted } from '@/lib/chat-preferences'
import { openUIText, parseOpenUI } from '@/lib/openui-lang'
import type { ActionLocale } from '@/lib/suggestions/action-title'
import { personLocale } from '@/lib/suggestions/action-title-server'
import { appOrigin } from '@/lib/mcp/resource'
import { BASE_PATH } from '@/lib/base-path'

import { deliverPhonePush } from '@/lib/mobile-push-delivery'
const BODY_MAX = 180
const MESSAGES = {
  'zh-CN': () => import('@/messages/zh-CN.json'),
  en: () => import('@/messages/en.json'),
} as const

/**
 * The push for a verification code, in the person's language: it only says
 * one came; the code stays in the app chat. Read straight from the messages:
 * next-intl's entry loads React hooks, which the react-server condition
 * (workflow steps, tests) does not have.
 */
export async function codePushBody(locale: ActionLocale): Promise<string> {
  return (await MESSAGES[locale]()).default.MobilePush.verificationCode
}

export { pushAllowed }

/**
 * The push text: the reply's first lines, without citation tokens or Markdown
 * marks. A card (OpenUI) is read as its words: its text, question and options.
 * Pushes have no buttons (mobile.md).
 */
export function pushBody(text: string): string {
  const card = parseOpenUI(text)
  const plain = (card === null ? text : openUIText(card))
    .replace(/\[\[(?:issue|run|artifact):[0-9a-f-]{36}\]\]/gi, '')
    .replace(/\[([^\]\n]+)\]\((?:[^)\s]+)\)/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > BODY_MAX ? `${plain.slice(0, BODY_MAX - 1)}…` : plain
}

/**
 * Sends a Coordinator (or bot) reply to every phone the person signed in on,
 * when their settings allow it and the chat's 通知 is on. Tapping the push opens that chat, or with `task` that
 * task at its attempt (2026-11-07). `text` null
 * is a reply about a verification code: the push only says one came, the code
 * stays in the app chat. Tokens Expo reports as gone are removed. Never throws.
 */
export async function pushReply(userId: string, botId: string, text: string | null, reasons: readonly PushReason[], task: { issueId: string; runId: string | null } | null = null): Promise<void> {
  try {
    if (!reasons.length || text?.trim() === '') return
    if (!pushAllowed(await readPreferences(userId), reasons)) return
    // 通知 off for this chat, on its page.
    if (await chatMuted(userId, botId)) return
    const tokens = await db.select({ token: mobilePushTokens.token }).from(mobilePushTokens).where(eq(mobilePushTokens.userId, userId))
    if (!tokens.length) return
    const [bot] = await db.select({ name: bots.name, coordinator: sql<boolean>`exists (select 1 from coordinator_bots cb where cb."botId" = ${bots.id})` }).from(bots).where(eq(bots.id, botId)).limit(1)
    // The app opens the Coordinator's chat by its own route (botId null), under its usual name.
    const coordinator = !bot || bot.coordinator
    const body = text === null ? await codePushBody(await personLocale(userId)) : pushBody(text)
    await deliverPhonePush(userId, { to: tokens.map(({ token }) => token), title: coordinator ? 'Coordinator' : bot.name, body,
      data: { botId: coordinator ? null : botId, ...(task ? { issueId: task.issueId, ...(task.runId ? { runId: task.runId } : {}) } : {}), serverUrl: `${appOrigin}${BASE_PATH}`, userId }, collapseId: botId }, await personLocale(userId))
  } catch (error) {
    console.error('phone_push_failed', { code: error instanceof Error && 'code' in error && typeof error.code === 'string' && /^cloud_[a-z_]+$/.test(error.code) ? error.code : 'push_unavailable' })
  }
}
