import chineseMessages from '@/messages/zh-CN.json'
import englishMessages from '@/messages/en.json'
import { hostedRefusal } from '@/lib/billing/hosted-usage'

/**
 * The status line for a turn Mikka 默认 refused, for places that cannot draw
 * the web's refusal line (components/billing/hosted-refusal-notice.tsx):
 * Telegram and the phone push. It reuses the keys of the line kept under the
 * message (components/coordinator/failure-reason.tsx), with Mikka 默认 named
 * since no mark sits beside it here. Null when the failure is not a refusal.
 */
export function hostedRefusalLine(error: string | null | undefined, locale: 'zh-CN' | 'en' = 'zh-CN'): string | null {
  const code = hostedRefusal(error)
  if (!code) return null
  const copy = (locale === 'en' ? englishMessages : chineseMessages).Billing.refusal
  const brand = locale === 'en' ? 'Mikka Default: ' : 'Mikka 默认'
  switch (code) {
    case 'verification_required': return copy.verificationRequiredPlain
    case 'free_allowance_used': return brand + copy.free_allowance_used
    case 'points_exhausted': return brand + copy.points_exhausted
    case 'platform_paused': return brand + copy.platform_paused
    default: return copy.unavailable
  }
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
