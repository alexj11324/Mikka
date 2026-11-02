import chineseMessages from '@/messages/zh-CN.json'
import englishMessages from '@/messages/en.json'
import { chatFailure, failureMessageKey, type ChatFailure } from '@/lib/chat-failure'

/**
 * The status line for a turn that failed for a reason the person can act on,
 * for places that cannot draw the web's line: Telegram and the phone push.
 * The words are the web's own (failureMessageKey, the key
 * components/coordinator/failure-reason.tsx reads), with Mikka 默认 named on
 * its states since no mark sits beside them here. Null for any other failure:
 * a crash is retried and has nothing for the person to do.
 */
export function failureLine(error: string | null | undefined, locale: 'zh-CN' | 'en' = 'zh-CN'): string | null {
  if (!error) return null
  const failure = chatFailure({ working: false, error })
  return failure && failure.kind !== 'failed' ? lineFor(failure, locale) : null
}

const BRANDED = new Set(['free_allowance_used', 'points_exhausted', 'platform_paused'])

function lineFor(failure: ChatFailure, locale: 'zh-CN' | 'en'): string {
  const messages = locale === 'en' ? englishMessages : chineseMessages
  const message = failureMessageKey(failure)
  const scope: Record<string, unknown> = message.namespace === 'Billing.refusal' ? messages.Billing.refusal : messages.Coordinator
  const text = message.key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], scope)
  if (typeof text !== 'string') throw new Error(`missing message ${message.namespace}.${message.key}`)
  return message.namespace === 'Billing.refusal' && BRANDED.has(message.key) ? `${locale === 'en' ? 'Mikka Default: ' : 'Mikka 默认'}${text}` : text
}

/**
 * Sends `line` to each Telegram chat waiting on the turn and, when the turn
 * carried events that may reach the phone, to the phone. One failing target
 * never stops the others.
 */
export async function deliverRefusalLine<Target, Event>(line: string, targets: readonly Target[], events: readonly Event[], send: { telegram: (target: Target, text: string) => Promise<void>; push: (text: string, events: Event[]) => Promise<void> }) {
  const failed: string[] = []
  for (const target of targets) {
    try { await send.telegram(target, line) } catch { failed.push('telegram') }
  }
  if (events.length) {
    try { await send.push(line, [...events]) } catch { failed.push('push') }
  }
  return { failed }
}
