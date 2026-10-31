import 'server-only'
import { eq, inArray } from 'drizzle-orm'
import { db } from '@/lib/db'
import { bots, mobilePushTokens } from '@/lib/db/schema'
import { readPreferences } from '@/lib/preferences'
import { pushAllowed } from '@/lib/push-allowed'
import type { PushReason } from '@/lib/push-reasons'
import { openUIText, parseOpenUI } from '@/lib/openui-lang'
import type { ActionLocale } from '@/lib/suggestions/action-title'
import { personLocale } from '@/lib/suggestions/action-title-server'

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
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
 * when their settings allow it. Tapping the push opens that chat. `text` null
 * is a reply about a verification code: the push only says one came, the code
 * stays in the app chat. Tokens Expo reports as gone are removed. Never throws.
 */
export async function pushReply(userId: string, botId: string | null, text: string | null, reasons: readonly PushReason[]): Promise<void> {
  try {
    if (!reasons.length || text?.trim() === '') return
    if (!pushAllowed(await readPreferences(userId), reasons)) return
    const tokens = await db.select({ token: mobilePushTokens.token }).from(mobilePushTokens).where(eq(mobilePushTokens.userId, userId))
    if (!tokens.length) return
    const [bot] = botId ? await db.select({ name: bots.name }).from(bots).where(eq(bots.id, botId)).limit(1) : []
    const body = text === null ? await codePushBody(await personLocale(userId)) : pushBody(text)
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json',
        ...(process.env.EXPO_ACCESS_TOKEN ? { authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}),
      },
      body: JSON.stringify(tokens.map(({ token }) => ({ to: token, title: bot?.name ?? 'Coordinator', body, sound: 'default', data: { botId } }))),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`Expo push returned ${response.status}`)
    const result = await response.json() as { data?: { status: string; details?: { error?: string } }[] }
    const gone = (result.data ?? []).flatMap((ticket, index) => ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered' ? [tokens[index].token] : [])
    if (gone.length) await db.delete(mobilePushTokens).where(inArray(mobilePushTokens.token, gone))
  } catch (error) {
    console.error('Phone push failed', error instanceof Error ? error.message : error)
  }
}
