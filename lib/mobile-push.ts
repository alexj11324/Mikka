import 'server-only'
import { eq, inArray } from 'drizzle-orm'
import { db } from '@/lib/db'
import { bots, mobilePushTokens } from '@/lib/db/schema'
import { readPreferences, type Preferences } from '@/lib/preferences'
import type { PushReason } from '@/lib/push-reasons'

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
const BODY_MAX = 180

const FLAG: Record<PushReason, keyof Preferences> = { decide: 'pushDecide', review: 'pushReview', finished: 'pushFinished', briefing: 'pushBriefing' }

/** Whether the person's 通知 settings let a reply with these reasons reach the phone. */
export function pushAllowed(preferences: Preferences, reasons: readonly PushReason[]): boolean {
  return preferences.proactive && reasons.some(reason => preferences[FLAG[reason]] === true)
}

/** The push text: the reply's first lines, without citation tokens or Markdown marks. Pushes have no buttons (mobile.md). */
export function pushBody(text: string): string {
  const plain = text
    .replace(/\[\[(?:issue|run|artifact):[0-9a-f-]{36}\]\]/gi, '')
    .replace(/\[([^\]\n]+)\]\((?:[^)\s]+)\)/g, '$1')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > BODY_MAX ? `${plain.slice(0, BODY_MAX - 1)}…` : plain
}

/**
 * Sends a Coordinator (or bot) reply to every phone the person signed in on,
 * when their settings allow it. Tapping the push opens that chat. Tokens
 * Expo reports as gone are removed. Never throws.
 */
export async function pushReply(userId: string, botId: string | null, text: string, reasons: readonly PushReason[]): Promise<void> {
  try {
    if (!reasons.length || !text.trim()) return
    if (!pushAllowed(await readPreferences(userId), reasons)) return
    const tokens = await db.select({ token: mobilePushTokens.token }).from(mobilePushTokens).where(eq(mobilePushTokens.userId, userId))
    if (!tokens.length) return
    const [bot] = botId ? await db.select({ name: bots.name }).from(bots).where(eq(bots.id, botId)).limit(1) : []
    const body = pushBody(text)
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
