'use client'

import useSWR, { unstable_serialize as serialize } from 'swr'
import useSWRInfinite, { unstable_serialize } from 'swr/infinite'
import { automationHistory, getAutomation, listAutomations } from '@/app/actions/automations'
import { useLiveKey } from '@/hooks/use-live-key'
import type { AutomationHistory, AutomationList, AutomationView } from '@/lib/schedules/automation-view'

type Read<T> = { error?: string } | T

function unwrap<T>(result: Read<T>): T {
  if (result && typeof result === 'object' && 'error' in result && result.error) throw new Error(result.error)
  return result as T
}

const listKey = (workspaceId: string) => (index: number, previous: AutomationList | null) =>
  index > 0 && !previous?.nextCursor ? null : ['automations', workspaceId, previous?.nextCursor ?? null] as const

/**
 * 自动化: the workspace's automations, a page at a time. Read when the page opens and again only when the live
 * channel says a schedule changed (`schedule_list`); no timer.
 */
export function useAutomations(workspaceId: string | null) {
  const getKey = workspaceId ? listKey(workspaceId) : () => null
  const pages = useSWRInfinite<AutomationList>(getKey, ([, , cursor]: readonly [string, string, string | null]) =>
    listAutomations(cursor ? { cursor } : {}).then(unwrap<AutomationList>), { revalidateOnFocus: false, shouldRetryOnError: false, revalidateFirstPage: false })
  useLiveKey('schedule_list', workspaceId, workspaceId ? [unstable_serialize(getKey)] : [], workspaceId)
  const automations = [...new Map((pages.data ?? []).flatMap(page => page.schedules).map(row => [row.id, row])).values()]
  return { ...pages, automations, more: Boolean(pages.data?.at(-1)?.nextCursor) }
}

export const automationKey = (workspaceId: string, id: string) => ['automation', workspaceId, id] as const
export const automationHistoryKey = (workspaceId: string, id: string) => ['automation-history', workspaceId, id] as const

/** One automation and its runs, live like the list. */
export function useAutomation(workspaceId: string | null, id: string | null) {
  const key = workspaceId && id ? automationKey(workspaceId, id) : null
  const historyKey = workspaceId && id ? automationHistoryKey(workspaceId, id) : null
  const automation = useSWR<AutomationView | null>(key, () => getAutomation(id!).then(unwrap<{ automation: AutomationView | null }>).then(value => value.automation),
    { revalidateOnFocus: false, shouldRetryOnError: false })
  const history = useSWR<AutomationHistory>(historyKey, () => automationHistory(id!).then(unwrap<AutomationHistory>),
    { revalidateOnFocus: false, shouldRetryOnError: false })
  useLiveKey('schedule_list', workspaceId, key && historyKey ? [serialize(key), serialize(historyKey)] : [], workspaceId)
  return { automation, history }
}
