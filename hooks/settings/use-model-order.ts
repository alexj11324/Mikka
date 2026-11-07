'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import useSWR, { unstable_serialize } from 'swr'
import { useFormatter, useTranslations } from 'next-intl'
import { harnessName } from '@/components/labels/entity-labels'
import { arrayMove } from '@dnd-kit/sortable'
import { changeModelOrder, checkModelOrderQuota, type getModelOrder } from '@/app/actions/model-order'
import { useOwnE2BKey } from '@/components/settings/e2b-key-dialog'
import type { OrderRow, OrderView } from '@/lib/model-order'
import type { OrderHarness } from '@/lib/model-order-plan'
import { settingsRead } from '@/lib/settings-read'
import { settingsKeys } from '@/lib/swr/keys'
import { useLiveKey } from '@/hooks/use-live-key'
import { useActionError } from '@/lib/use-action-error'

export const modelOrderKey = settingsKeys.modelOrder
export const readModelOrder = (workspaceId: string) => settingsRead<Awaited<ReturnType<typeof getModelOrder>>>('model-order', { workspace: workspaceId })

export type ModelOrderChange = Parameters<typeof changeModelOrder>[0]
type Change = ModelOrderChange

/**
 * 模型与订阅 › 运行位置 and 优先使用的模型 (decision 2026-11-02-1400): the list,
 * one Agent's rows at a time, and each change saved at once. A refused reorder
 * puts the list back and marks the moved row (`unsaved`); 移出列表 can be undone
 * from its toast (decision 2026-11-02 R1–R3). The open-source page and the
 * hosted layer draw it each in their own look (docs/ui-overlay.md).
 */
export function useModelOrder(workspaceId: string) {
  const t = useTranslations('Settings.modelOrder')
  const actionError = useActionError()
  const order = useSWR(modelOrderKey(workspaceId), () => readModelOrder(workspaceId))
  const e2b = useOwnE2BKey()
  const [failed, setFailed] = useState<{ message: string; retry: () => void } | null>(null)
  // A refused reorder: the list is back as saved and the moved row says so, with 重试 (R3).
  const [unsaved, setUnsaved] = useState<{ id: string; to: number } | null>(null)
  const [pending, setPending] = useState(false)
  const data = order.data && !order.data.error ? order.data : null
  // One Agent's list at a time (decision 2026-11-05-0400): 优先使用的 Agent picks it; each keeps its own order.
  const shown = data ? data.entries.filter(entry => entry.harness === data.preferredHarness) : []
  const offered = data ? data.candidates.filter(candidate => candidate.harness === data.preferredHarness) : []
  // The other Agent's list is the fallback dispatch takes after this one (decision 2026-11-05-0400).
  const other: OrderHarness = data?.preferredHarness === 'codex' ? 'claude_code' : 'codex'
  const backup = data ? data.entries.filter(entry => entry.harness === other) : []
  const offeredOther = data ? data.candidates.filter(candidate => candidate.harness === other) : []
  // A subscription connected, paused or read again elsewhere: this list re-reads (no polling).
  useLiveKey('model_settings', workspaceId, [unstable_serialize(modelOrderKey(workspaceId))], workspaceId, { minIntervalMs: 2_000 })

  async function checkQuota(connectionId: string) {
    setPending(true); setFailed(null)
    try {
      // The server resolves the credential's owner from authorized candidates,
      // including a teammate's currently shared subscription.
      const result = await checkModelOrderQuota(connectionId, workspaceId)
      if (result.error) throw new Error('Allowance unconfirmed')
      await order.mutate(result, { revalidate: false })
      const entries = result.entries.filter(row => row.source.kind === 'subscription' && row.source.connectionId === connectionId)
      if (!entries.length || entries.some(row => row.block?.reason === 'checking')) throw new Error('Allowance unconfirmed')
    } catch {
      setFailed({ message: t('quotaCheckUnconfirmed'), retry: () => void checkQuota(connectionId) })
    } finally { setPending(false) }
  }

  /** Saves one change; `onFail` replaces the page's error line for changes with their own place to say so. */
  async function save(change: Change, optimistic?: OrderView, onFail?: () => void) {
    setPending(true); setFailed(null); setUnsaved(null)
    const fail = (error?: string) => onFail ? onFail() : setFailed({ message: actionError(error), retry: () => void save(change, optimistic) })
    const restore = async () => {
      if (optimistic && data) await order.mutate(data, { revalidate: false })
      // Keep the last saved value visible even if an offline reread also fails.
      await order.mutate().catch(() => undefined)
    }
    try {
      if (optimistic) await order.mutate(optimistic, { revalidate: false })
      const result = await changeModelOrder(change, workspaceId)
      if (result.error) { fail(result.error); await restore(); return false }
      await order.mutate(result, { revalidate: false })
      return true
    } catch {
      fail()
      await restore()
      return false
    } finally { setPending(false) }
  }
  const move = (from: number, to: number) => {
    if (!data) return
    // 重试 on a list that changed meanwhile: nothing left to move clears the mark.
    if (to < 0 || to >= shown.length || from === to) { setUnsaved(null); return }
    // Only this Agent's rows move, into each other's places; the other Agent's list is untouched.
    const moved = arrayMove(shown, from, to)
    const queue = [...moved]
    const entries = data.entries.map(entry => entry.harness === data.preferredHarness ? queue.shift()! : entry)
    const id = shown[from].id
    void save({ kind: 'reorder', ids: moved.map(entry => entry.id) }, { ...data, entries }, () => setUnsaved({ id, to }))
  }
  /** 移出列表 at once; the toast's 撤销 puts the same model back where it was (R2). */
  const remove = async (row: OrderRow) => {
    if (!data) return
    const at = data.entries.findIndex(entry => entry.id === row.id)
    if (!await save({ kind: 'remove', id: row.id }, { ...data, entries: data.entries.filter(entry => entry.id !== row.id) })) return
    toast(t('removed', { model: row.model }), {
      action: { label: t('undo'), onClick: () => { void save({ kind: 'add', at, entries: [{ harness: row.harness, model: row.model, source: row.source }] }) } },
    })
  }

  const loadError = order.data?.error || order.error ? actionError(order.data?.error) : null
  return { data, loadError, e2b, pending, failed, unsaved, shown, offered, other, backup, offeredOther, checkQuota, save, move, remove, reload: order.mutate }
}

/**
 * What a row of 优先使用的模型 says about itself: 顺序未保存 (it wins until 重试
 * or the next change, R3), 待检查, 可用, or why it cannot run now.
 */
export function useOrderRowStatus() {
  const t = useTranslations('Settings.modelOrder')
  const runtimeT = useTranslations('RunErrors.subscription_local_runtime_unavailable')
  const format = useFormatter()
  return (row: OrderRow, unsaved = false) => {
    const block = row.block
    const checking = !unsaved && block?.reason === 'checking'
    const warn = Boolean((block && !checking) || unsaved)
    const status = unsaved ? t('orderUnsaved') : checking ? t('blocked.checking')
      : !block ? t('ready')
      : block.reason === 'quota' && block.resetsAt ? t('quotaUntil', { time: format.dateTime(new Date(block.resetsAt), { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) })
        : block.reason === 'noDevice' ? (block.device.why === 'subscriptionRuntimeUnavailable' ? runtimeT(block.device.detail ?? 'default') : block.device.why === 'none' ? t('noDevice.none') : t(`noDevice.${block.device.why}`, { device: block.device.device, count: block.device.count, harness: harnessName(row.harness) }))
          : t(`blocked.${block.reason}`)
    return { status, checking, warn }
  }
}

/** What fixes a row that cannot run (R1): check its quota, open 设备, or go to its subscription or key. */
export type OrderRowRepair =
  | { kind: 'checkQuota'; connectionId: string }
  | { kind: 'devices' }
  | { kind: 'anchor'; anchor: string; label: 'enableSubscription' | 'reconnectSubscription' | 'openApiKey' | 'openSubscription' }

export function orderRowRepair(row: OrderRow): OrderRowRepair | null {
  const reason = row.block?.reason
  if (reason === 'checking' && row.source.kind === 'subscription') return { kind: 'checkQuota', connectionId: row.source.connectionId }
  if (reason === 'noDevice') return { kind: 'devices' }
  if ((reason === 'paused' || reason === 'expired') && row.source.kind === 'subscription') return { kind: 'anchor', anchor: `subscription-${row.source.connectionId}`, label: reason === 'paused' ? 'enableSubscription' : 'reconnectSubscription' }
  if (reason === 'keyRefused' && row.source.kind === 'api_key') return { kind: 'anchor', anchor: `api-key-${row.source.keyId}`, label: 'openApiKey' }
  // A removed source may have no row left: its source section keeps the recovery control.
  if (reason === 'missing' || reason === 'removed') return { kind: 'anchor', anchor: row.source.kind === 'subscription' ? 'subscriptions-heading' : 'api-keys-heading', label: row.source.kind === 'subscription' ? 'openSubscription' : 'openApiKey' }
  return null
}
