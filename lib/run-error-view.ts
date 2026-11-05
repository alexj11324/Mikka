import { parseCodedErrorText } from '@mikka/protocol/coded-error'
import { USER_ERROR_CODES, type UserErrorCode } from '@mikka/protocol/user-error-codes'
import { subscriptionRefusal } from '@/lib/subscription-refusal'

/**
 * Where a run's stored error has its words in messages/*.json, or null when it
 * is not a known code (an agent's own failure text, shown as it is). A known
 * code shows its copy; the raw code goes only into the details area
 * (decision 2026-11-05-0330).
 */
export type RunErrorCopy =
  | { namespace: 'RunErrors'; key: `${UserErrorCode}.${string}`; code: string }
  | { namespace: 'Coordinator'; key: `subscriptionRefusal.${NonNullable<ReturnType<typeof subscriptionRefusal>>}`; code: string }

export function runErrorCopy(text: string | null | undefined): RunErrorCopy | null {
  const line = text?.split('\n').find(part => part.trim())?.trim()
  if (!line) return null
  const parsed = parseCodedErrorText(line)
  if (parsed && Object.hasOwn(USER_ERROR_CODES, parsed.code)) {
    const code = parsed.code as UserErrorCode
    const details: readonly string[] = USER_ERROR_CODES[code]
    const detail = parsed.detail && details.includes(parsed.detail) ? parsed.detail : 'default'
    return { namespace: 'RunErrors', key: `${code}.${detail}`, code: line }
  }
  const notice = subscriptionRefusal(line)
  return notice ? { namespace: 'Coordinator', key: `subscriptionRefusal.${notice}`, code: line } : null
}
