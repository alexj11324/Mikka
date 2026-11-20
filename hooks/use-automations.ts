'use client'

import useSWR, { unstable_serialize as serialize, type useSWRConfig } from 'swr'
import useSWRInfinite, { unstable_serialize } from 'swr/infinite'
import { automationBatches, automationHistory, automationUsage, getAutomation, listAutomations } from '@/app/actions/automations'
import { useLiveKey } from '@/hooks/use-live-key'
import type { AutomationHistory, AutomationList, AutomationUsage, AutomationView, WebhookBatchPage } from '@/lib/schedules/automation-view'

type Read<T> = { error?: string } | T

function unwrap<T>(result: Read<T>): T {
  if (result && typeof result === 'object' && 'error' in result && result.error) throw new Error(result.error)
  return result as T
}

/** 我的 (owner) and 定时 (trigger) narrow the list on the server: it arrives a page at a time, so the page cannot filter it. */
export type AutomationListFilter = { deleted?: boolean; owner?: 'me'; trigger?: 'schedule' }
const FILTER_VARIANTS: Pick<AutomationListFilter, 'owner' | 'trigger'>[] = [{}, { owner: 'me' }, { trigger: 'schedule' }, { owner: 'me', trigger: 'schedule' }]

const listKey = (workspaceId: string, { deleted = false, owner, trigger }: AutomationListFilter) => (index: number, previous: AutomationList | null) =>
  index > 0 && !previous?.nextCursor ? null : ['automations', workspaceId, deleted, previous?.nextCursor ?? null, owner ?? null, trigger ?? null] as const

// Forget each old cursor before refreshing its infinite key. Revalidation also clears SWR's
// in-flight deduplication when the destination filter is hidden, so reopening it reads the writer's result.
// Every 我的 / 定时 variant of the list is refreshed: a write can move a row into or out of any of them.
export async function invalidateAutomationList(mutate: ReturnType<typeof useSWRConfig>['mutate'], workspaceId: string, deleted: boolean) {
  await mutate(key => Array.isArray(key) && key[0] === 'automations' && key[1] === workspaceId && key[2] === deleted, undefined, { revalidate: false })
  await Promise.all(FILTER_VARIANTS.map(variant => mutate(unstable_serialize(listKey(workspaceId, { deleted, ...variant })), undefined, { revalidate: true })))
}

/**
 * 自动化: the workspace's automations, a page at a time. Read when the page opens and again only when the live
 * channel says a schedule changed (`schedule_list`); no timer.
 */
export function useAutomations(workspaceId: string | null, filter: AutomationListFilter = {}) {
  const getKey = workspaceId ? listKey(workspaceId, filter) : () => null
  const pages = useSWRInfinite<AutomationList>(getKey, ([, selectedWorkspace, deleted, cursor, owner, trigger]: readonly [string, string, boolean, string | null, 'me' | null, 'schedule' | null]) =>
    listAutomations({ deleted, ...(cursor ? { cursor } : {}), ...(owner ? { owner } : {}), ...(trigger ? { trigger } : {}) }, selectedWorkspace).then(unwrap<AutomationList>), { revalidateOnFocus: false, shouldRetryOnError: false, revalidateFirstPage: false })
  useLiveKey('schedule_list', workspaceId, workspaceId ? [unstable_serialize(getKey)] : [], workspaceId, { revalidate: pages.mutate })
  const automations = [...new Map((pages.data ?? []).flatMap(page => page.schedules).map(row => [row.id, row])).values()]
  return { ...pages, automations, counts: pages.data?.[0]?.counts, more: Boolean(pages.data?.at(-1)?.nextCursor) }
}

export const automationKey = (workspaceId: string, id: string) => ['automation', workspaceId, id] as const
export const automationHistoryKey = (workspaceId: string, id: string) => ['automation-history', workspaceId, id] as const

/** One automation and its runs, live like the list. */
export function useAutomation(workspaceId: string | null, id: string | null) {
  const key = workspaceId && id ? automationKey(workspaceId, id) : null
  const historyKey = workspaceId && id ? automationHistoryKey(workspaceId, id) : null
  const automation = useSWR<AutomationView | null>(key, () => getAutomation(id!, workspaceId!).then(unwrap<{ automation: AutomationView | null }>).then(value => value.automation),
    { revalidateOnFocus: false, shouldRetryOnError: false })
  const history = useSWR<AutomationHistory>(historyKey, () => automationHistory(id!, workspaceId!).then(unwrap<AutomationHistory>),
    { revalidateOnFocus: false, shouldRetryOnError: false })
  useLiveKey('schedule_list', workspaceId, key && historyKey ? [serialize(key), serialize(historyKey)] : [], workspaceId)
  return { automation, history }
}

export function useWebhookBatches(workspaceId: string, scheduleId: string) {
  const getKey = (index: number, previous: WebhookBatchPage | null) =>
    index > 0 && !previous?.nextCursor ? null : ['automation-batches', workspaceId, scheduleId, previous?.nextCursor ?? null] as const
  const pages = useSWRInfinite<WebhookBatchPage>(getKey, ([, selectedWorkspace, id, cursor]: readonly [string, string, string, string | null]) =>
    automationBatches({ scheduleId: id, ...(cursor ? { cursor } : {}) }, selectedWorkspace).then(unwrap<WebhookBatchPage>),
    { revalidateOnFocus: false, shouldRetryOnError: false, revalidateFirstPage: false })
  useLiveKey('schedule_list', workspaceId, [unstable_serialize(getKey)], workspaceId, { revalidate: pages.mutate })
  return pages
}

/** 用量 per day, read on open and again when the live channel says a schedule changed. */
export function useAutomationUsage(workspaceId: string | null, id: string | null) {
  const key = workspaceId && id ? ['automation-usage', workspaceId, id] as const : null
  const usage = useSWR<AutomationUsage>(key, () => automationUsage({ scheduleId: id! }, workspaceId!).then(unwrap<AutomationUsage>), { revalidateOnFocus: false, shouldRetryOnError: false })
  useLiveKey('schedule_list', workspaceId, key ? [serialize(key)] : [], workspaceId)
  return usage
}
