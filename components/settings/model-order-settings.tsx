'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import useSWR from 'swr'
import { useFormatter, useTranslations } from 'next-intl'
import { ChevronDown, GripVertical, KeyRound, MoreHorizontal } from 'lucide-react'
import { arrayMove } from '@dnd-kit/sortable'
import { Kanban, KanbanColumnContent, KanbanItem, KanbanItemHandle } from '@/components/reui/kanban'
import { changeModelOrder, checkModelOrderQuota, type getModelOrder } from '@/app/actions/model-order'
import { ModelLabel, harnessName } from '@/components/labels/entity-labels'
import { SettingRow, SettingsSaveError, SettingsSection, settingsSectionAction } from '@/components/settings/primitives'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { FieldError, FieldLegend, FieldSet } from '@/components/ui/field'
import { Label } from '@/components/ui/label'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { E2BKeyDialog, useOwnE2BKey } from '@/components/settings/e2b-key-dialog'
import type { OrderRow, OrderView } from '@/lib/model-order'
import type { OrderCandidate, OrderHarness } from '@/lib/model-order-plan'
import { settingsRead } from '@/lib/settings-read'
import { settingsHref } from '@/lib/settings-sections'
import { usePresence } from '@/lib/use-presence'
import { useActionError } from '@/lib/use-action-error'
import { cn } from '@/lib/utils'

export const modelOrderKey = (workspaceId: string) => ['settings:model-order', workspaceId] as const
export const readModelOrder = (workspaceId: string) => settingsRead<Awaited<ReturnType<typeof getModelOrder>>>('model-order', { workspace: workspaceId })

type Change = Parameters<typeof changeModelOrder>[0]
type Candidate = OrderView['candidates'][number]
const sourceKey = (item: Pick<OrderCandidate, 'harness' | 'model' | 'source'>) =>
  `${item.harness}:${item.model}:${item.source.kind === 'subscription' ? item.source.connectionId : item.source.keyId}`

/**
 * 模型与订阅 › 运行位置 and 优先使用的模型 (decision 2026-11-02-1400). New runs take
 * the first model here that can run now, on a computer that takes part in
 * scheduling (本地) or the person's own E2B machine (云端). Drag a row, use
 * its handle with Space and the arrow keys, or its menu (移到最前, 上移, 下移)
 * to reorder; each change saves at once. A refused reorder puts the list back
 * and marks the moved row 顺序未保存 with 重试; 移出列表 can be undone from its
 * toast (decision 2026-11-02 R1–R3).
 */
export function ModelOrderSettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.modelOrder')
  const commonT = useTranslations('Common')
  const actionError = useActionError()
  const order = useSWR(modelOrderKey(workspaceId), () => readModelOrder(workspaceId))
  const e2b = useOwnE2BKey()
  const [failed, setFailed] = useState<{ message: string; retry: () => void } | null>(null)
  // A refused reorder: the list is back as saved and the moved row says so, with 重试 (R3).
  const [unsaved, setUnsaved] = useState<{ id: string; to: number } | null>(null)
  const [pending, setPending] = useState(false)
  const [adding, setAdding] = useState(false)
  const [keyOpen, setKeyOpen] = useState(false)
  const keyDialog = usePresence(keyOpen)
  const data = order.data && !order.data.error ? order.data : null

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
    try {
      if (optimistic) await order.mutate(optimistic, { revalidate: false })
      const result = await changeModelOrder(change, workspaceId)
      if (result.error) { fail(result.error); await order.mutate(); return false }
      await order.mutate(result, { revalidate: false })
      return true
    } catch {
      fail()
      await order.mutate()
      return false
    } finally { setPending(false) }
  }
  const move = (from: number, to: number) => {
    if (!data) return
    // 重试 on a list that changed meanwhile: nothing left to move clears the mark.
    if (to < 0 || to >= data.entries.length || from === to) { setUnsaved(null); return }
    const entries = arrayMove(data.entries, from, to)
    const id = data.entries[from].id
    void save({ kind: 'reorder', ids: entries.map(entry => entry.id) }, { ...data, entries }, () => setUnsaved({ id, to }))
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

  if (order.data?.error || order.error) return <FieldError>{actionError(order.data?.error)}</FieldError>
  if (!data) return <SettingsSection id="model-order-heading" title={t('title')}><p role="status" className="px-5 py-4 text-sm text-muted-foreground">{t('loading')}</p></SettingsSection>

  const locationLine = data.location === 'local'
    ? data.firstDevice ? t('localFirst', { count: data.devices, device: data.firstDevice }) : t('localDevices', { count: data.devices })
    : e2b.configured === false ? t('cloudNoKey') : null
  // R1: what fixes or explains the location sits on its row: 打开设备 for 本地; 填入 E2B Key for 云端 without one.
  const locationAction = data.location === 'local'
    ? <Button nativeButton={false} variant="secondary" size="sm" render={<Link href={settingsHref('computers', workspaceId)} />}>{t('openDevices')}</Button>
    : e2b.configured === false && <Button type="button" variant="secondary" size="sm" onClick={() => setKeyOpen(true)}>{t('setE2BKey')}</Button>
  const locationState = data.location !== 'cloud' ? undefined : e2b.configured === undefined ? 'checking' : !e2b.configured ? 'missingKey' : undefined
  const repair = (row: OrderRow) => {
    const reason = row.block?.reason
    if (reason === 'checking' && row.source.kind === 'subscription') return <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => { if (row.source.kind === 'subscription') void checkQuota(row.source.connectionId) }}>{t('checkQuota')}</Button>
    if (reason === 'cloudNotConfigured' || (!row.block && locationState === 'missingKey')) return <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => setKeyOpen(true)}>{t('setE2BKey')}</Button>
    if (reason === 'noDevice') return <Button nativeButton={false} variant="secondary" size="sm" render={<Link href={settingsHref('computers', workspaceId)} />}>{t('openDevices')}</Button>
    if ((reason === 'paused' || reason === 'expired') && row.source.kind === 'subscription') return <Button nativeButton={false} variant="secondary" size="sm" render={<a href={`#subscription-${row.source.connectionId}`} />}>{t(reason === 'paused' ? 'enableSubscription' : 'reconnectSubscription')}</Button>
    if (reason === 'keyRefused' && row.source.kind === 'api_key') return <Button nativeButton={false} variant="secondary" size="sm" render={<a href={`#api-key-${row.source.keyId}`} />}>{t('openApiKey')}</Button>
    // A removed source may have no row left: its source section retains the recovery control.
    if (reason === 'missing') return <Button nativeButton={false} variant="secondary" size="sm" render={<a href={row.source.kind === 'subscription' ? '#subscriptions-heading' : '#api-keys-heading'} />}>{t(row.source.kind === 'subscription' ? 'openSubscription' : 'openApiKey')}</Button>
    return null
  }
  return <>
    <SettingsSection id="run-location-heading" title={t('location')}>
      <SettingRow title={data.location === 'local' ? t('local') : t('cloud')} description={locationLine ?? undefined}>
        <span className="flex items-center gap-2">
          {locationAction}
          <ToggleGroup aria-label={t('location')} variant="segment" spacing={0.5} value={[data.location]} disabled={pending}
            onValueChange={values => { const next = values[0]; if ((next === 'local' || next === 'cloud') && next !== data.location) void save({ kind: 'location', location: next }, { ...data, location: next }) }}>
            <ToggleGroupItem value="cloud">{t('cloud')}</ToggleGroupItem>
            <ToggleGroupItem value="local">{t('local')}</ToggleGroupItem>
          </ToggleGroup>
        </span>
      </SettingRow>
      {/* The person's own E2B key, whatever the location: 云端 runs and the bot's own cloud computer both use it (coordinator, 2026-11-02). */}
      {e2b.configured !== undefined && <SettingRow title={t('e2bKey')}>
        <span className="flex items-center gap-3">
          <span role="status" className="text-sm text-muted-foreground">{e2b.configured ? t('e2bKeySet') : t('e2bKeyMissing')}</span>
          <Button type="button" variant="secondary" size="sm" onClick={() => setKeyOpen(true)}>{e2b.configured ? t('e2bKeyReplace') : t('e2bKeyFill')}</Button>
        </span>
      </SettingRow>}
    </SettingsSection>
    {/* What a task dispatched to an Agent runs on (Alex, 2026-11-02): the preferred Agent and the models in
        order, one card. Bot chats pick their own model; this is a preference order, not a permission. */}
    <SettingsSection id="model-order-heading" title={t('title')} description={t('description')}
      action={data.entries.length > 0 && <Button type="button" {...settingsSectionAction} disabled={pending} onClick={() => setAdding(true)}>{t('add')}</Button>}>
      <SettingRow title={t('preferredAgent')} description={t('preferredAgentHint')}>
        <ToggleGroup aria-label={t('preferredAgent')} variant="segment" spacing={0.5} value={[data.preferredHarness]} disabled={pending}
          onValueChange={values => { const next = values[0]; if ((next === 'claude_code' || next === 'codex') && next !== data.preferredHarness) void save({ kind: 'preferred', harness: next }, { ...data, preferredHarness: next }) }}>
          <ToggleGroupItem value="claude_code">{harnessName('claude_code')}</ToggleGroupItem>
          <ToggleGroupItem value="codex">{harnessName('codex')}</ToggleGroupItem>
        </ToggleGroup>
      </SettingRow>
      {data.entries.length === 0
        ? <div className="flex flex-col items-center gap-3 px-5 py-7">
          {/* C8: one line naming what is missing, and the one button that gets it (R-41). */}
          {data.candidates.length > 0
            ? <><p className="text-sm text-muted-foreground">{t('empty')}</p>
              <Button type="button" disabled={pending} onClick={() => setAdding(true)}>{t('add')}</Button></>
            : <><p className="text-sm text-muted-foreground">{data.credentials === 0 ? t('emptyNoCredential') : t('emptyNoModels')}</p>
              <span className="flex flex-wrap justify-center gap-2">
                <Button nativeButton={false} variant="secondary" render={<a href="#subscriptions-heading" />}>{t(data.credentials === 0 ? 'connectSubscription' : 'openSubscription')}</Button>
                <Button nativeButton={false} variant="secondary" render={<a href="#api-keys-heading" />}>{t(data.credentials === 0 ? 'addApiKey' : 'openApiKey')}</Button>
              </span></>}
        </div>
        : <OrderList rows={data.entries} pending={pending} unsaved={unsaved} preferred={data.preferredHarness} locationState={locationState} repair={repair} onMove={move} onRemove={row => { void remove(row) }}
          onAgent={(row, harness) => void save({ kind: 'harness', id: row.id, harness }, { ...data, entries: data.entries.map(entry => entry.id === row.id ? { ...entry, harness } : entry) })} />}
    </SettingsSection>
    {failed && <SettingsSaveError message={failed.message} retryLabel={commonT('retry')} onRetry={failed.retry} />}
    {adding && <AddModelsDialog candidates={data.candidates} onClose={async picked => {
      setAdding(false)
      if (picked.length) await save({ kind: 'add', entries: picked.map(({ harness, model, source }) => ({ harness, model, source })) })
    }} />}
    {keyDialog.value && e2b.configured !== undefined && <E2BKeyDialog open={keyDialog.open} onOpenChangeComplete={keyDialog.onOpenChangeComplete} configured={e2b.configured}
      onClose={changed => { setKeyOpen(false); if (changed) void Promise.all([e2b.mutate(), order.mutate()]) }} />}
  </>
}

function OrderList({ rows, pending, unsaved, preferred, locationState, repair, onMove, onRemove, onAgent }: { rows: OrderRow[]; pending: boolean; unsaved: { id: string; to: number } | null; preferred: OrderHarness; locationState?: 'checking' | 'missingKey'; repair: (row: OrderRow) => ReactNode; onMove: (from: number, to: number) => void; onRemove: (row: OrderRow) => void; onAgent: (row: OrderRow, harness: OrderHarness) => void }) {
  const t = useTranslations('Settings.modelOrder')
  // No live reorder while dragging (the sortable strategy shows the shift): a live reorder moved the row under
  // the pointer, and a drop before dnd-kit re-measured landed on the stale target and put the row back (#1000).
  const items = rows
  const name = (id: string | number) => rows.find(row => row.id === id)?.model ?? ''
  const position = (id: string | number) => items.findIndex(row => row.id === id) + 1
  return <Kanban value={{ models: items }} getItemValue={row => row.id}
    onValueChange={() => {}}
    onMove={({ activeIndex, overIndex }) => { if (activeIndex >= 0 && overIndex >= 0 && activeIndex !== overIndex) onMove(activeIndex, overIndex) }}
    accessibility={{
      screenReaderInstructions: { draggable: t('dragInstructions') },
      announcements: {
        onDragStart: ({ active }) => t('dragStart', { model: name(active.id), position: position(active.id) }),
        onDragOver: ({ active, over }) => over ? t('dragOver', { model: name(active.id), position: position(over.id) }) : undefined,
        onDragEnd: ({ active, over }) => over ? t('dragEnd', { model: name(active.id), position: position(over.id) }) : undefined,
        onDragCancel: ({ active }) => t('dragCancel', { model: name(active.id) }),
      },
    }}>
    <KanbanColumnContent value="models" aria-label={t('title')} className="gap-0 divide-y divide-border" render={<ol />}>
      {items.map((row, index) => <OrderItem key={row.id} row={row} index={index} last={index === items.length - 1} pending={pending} preferred={preferred} locationState={locationState} repair={repair(row)} onAgent={harness => onAgent(row, harness)}
        retry={unsaved?.id === row.id ? () => onMove(index, Math.min(unsaved.to, items.length - 1)) : undefined}
        onFirst={() => onMove(index, 0)} onUp={() => onMove(index, index - 1)} onDown={() => onMove(index, index + 1)} onRemove={() => onRemove(row)} />)}
    </KanbanColumnContent>
  </Kanban>
}

function OrderItem({ row, index, last, pending, preferred, locationState, repair, retry, onAgent, onFirst, onUp, onDown, onRemove }: { row: OrderRow; index: number; last: boolean; pending: boolean; preferred: OrderHarness; locationState?: 'checking' | 'missingKey'; repair?: ReactNode; retry?: () => void; onAgent: (harness: OrderHarness) => void; onFirst: () => void; onUp: () => void; onDown: () => void; onRemove: () => void }) {
  const t = useTranslations('Settings.modelOrder')
  const commonT = useTranslations('Common')
  const format = useFormatter()
  const block = row.block
  // 顺序未保存 wins over the row's own state until 重试 or the next change (R3).
  const checking = !retry && (block?.reason === 'checking' || (!block && locationState === 'checking'))
  const warn = Boolean((block && !checking) || retry || (!block && locationState === 'missingKey'))
  const status = retry ? t('orderUnsaved') : checking ? t('blocked.checking')
    : block?.reason === 'cloudNotConfigured' || (!block && locationState === 'missingKey') ? t('cloudNoKey')
    : !block ? t('ready')
    : block.reason === 'quota' && block.resetsAt ? t('quotaUntil', { time: format.dateTime(new Date(block.resetsAt), { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) })
      : block.reason === 'noDevice' ? (block.device.why === 'none' ? t('noDevice.none') : t(`noDevice.${block.device.why}`, { device: block.device.device, count: block.device.count, harness: harnessName(row.harness) }))
        : t(`blocked.${block.reason}`)
  // The handle carries the drag semantics; the row stays a list item (the primitive puts role=button on the item too).
  return <KanbanItem value={row.id} disabled={pending} render={<li />} role="listitem" tabIndex={-1} aria-roledescription={undefined} className="flex flex-wrap items-center gap-x-3 gap-y-2 bg-card py-3 pr-3 pl-2 data-[dragging=true]:relative data-[dragging=true]:z-10 data-[dragging=true]:rounded-xl data-[dragging=true]:shadow-lg data-[dragging=true]:ring-1 data-[dragging=true]:ring-border">
    <KanbanItemHandle render={<Button type="button" variant="ghost" size="icon-sm" aria-label={t('handle', { model: row.model, position: index + 1 })} />} className="touch-none text-muted-foreground">
      <GripVertical aria-hidden="true" />
    </KanbanItemHandle>
    <span aria-hidden="true" className="w-4 shrink-0 text-center text-xs text-muted-foreground tabular-nums">{index + 1}</span>
    <span className="flex min-w-0 flex-1 basis-40 flex-col gap-0.5">
      <span className="flex min-w-0 items-center text-sm font-medium">
        {row.source.kind === 'api_key' ? <span className="inline-flex min-w-0 items-center gap-1.5"><KeyRound aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /><span className="truncate">{row.model}</span></span>
          : <ModelLabel model={row.model} source={row.harness} />}
      </span>
      <span className="truncate text-xs text-muted-foreground">{`${sourceName(t, row)} · ${agentsLine(t, row.agents)}`}</span>
    </span>
    {/* The row's controls: beside the model where they fit, on their own line on a phone, so the name is never cut to a letter. */}
    <span className="ml-auto flex shrink-0 items-center gap-3">
    {/* A model both Agents run: its Agent here, 优先 marking the preferred one (Harness draft). */}
    {row.agents.length > 1 && <DropdownMenu>
      <DropdownMenuTrigger disabled={pending} render={<Button variant="secondary" size="sm" aria-label={t('agentMenu', { model: row.model, agent: harnessName(row.harness) })} />}>
        {harnessName(row.harness)}<ChevronDown aria-hidden="true" data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('agentSection')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={row.harness} onValueChange={value => { if ((value === 'claude_code' || value === 'codex') && value !== row.harness) onAgent(value) }}>
            {row.agents.map(agent => <DropdownMenuRadioItem key={agent} value={agent}>
              <span className="flex-1">{harnessName(agent)}</span>{agent === preferred && <span className="text-xs text-muted-foreground">{t('preferredMark')}</span>}
            </DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>}
    <span className="flex shrink-0 flex-col items-end gap-1.5">
      <span role="status" className={cn('flex items-center gap-1.5 text-xs', retry ? 'text-destructive' : warn ? 'text-warning-foreground' : 'text-muted-foreground')}>
        <span aria-hidden="true" className={cn('size-1.5 rounded-full', retry ? 'bg-destructive' : warn ? 'bg-warning' : checking ? 'bg-muted-foreground' : 'bg-success')} />{status}
      </span>
      {!retry && repair}
    </span>
    {retry && <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={retry}>{commonT('retry')}</Button>}
    <DropdownMenu>
      <DropdownMenuTrigger disabled={pending} render={<Button variant="ghost" size="icon-sm" aria-label={t('rowMenu', { model: row.model })} />}><MoreHorizontal aria-hidden="true" /></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuItem disabled={index === 0} onClick={onFirst}>{t('moveFirst')}</DropdownMenuItem>
          <DropdownMenuItem disabled={index === 0} onClick={onUp}>{t('moveUp')}</DropdownMenuItem>
          <DropdownMenuItem disabled={last} onClick={onDown}>{t('moveDown')}</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem variant="destructive" onClick={onRemove}>{t('remove')}</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    </span>
  </KanbanItem>
}

type T = ReturnType<typeof useTranslations<'Settings.modelOrder'>>
/** 「只能用 Claude Code」 or 「两种 Agent 都能跑」: which Agents a credential's model runs on. */
function agentsLine(t: T, agents: readonly OrderHarness[]) {
  return agents.length > 1 ? t('bothAgents') : t('onlyAgent', { agent: harnessName(agents[0] ?? 'claude_code') })
}

/** Which credential a model comes from: the subscription's product, or the key's provider. */
function sourceName(t: T, item: { source: OrderCandidate['source']; provider: string }) {
  if (item.source.kind === 'subscription') return item.provider === 'codex' ? t('source.codex') : t('source.claude')
  return t('source.apiKey', { provider: t.has(`provider.${item.provider}` as never) ? t(`provider.${item.provider}` as never) : item.provider })
}

function AddModelsDialog({ candidates, onClose }: { candidates: Candidate[]; onClose: (picked: Candidate[]) => void }) {
  const t = useTranslations('Settings.modelOrder')
  const commonT = useTranslations('Common')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const groups = [...new Map(candidates.map(item => [item.source.kind === 'subscription' ? item.source.connectionId : item.source.keyId, item])).values()]
    .map(head => ({ head, items: candidates.filter(item => (item.source.kind === 'subscription' ? item.source.connectionId : item.source.keyId) === (head.source.kind === 'subscription' ? head.source.connectionId : head.source.keyId)) }))
  const chosen = candidates.filter(item => picked.has(sourceKey(item)))
  return <Dialog open onOpenChange={open => { if (!open) onClose([]) }}>
    <DialogContent>
      <DialogHeader><DialogTitle>{t('add')}</DialogTitle></DialogHeader>
      <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
        {groups.map(group => <FieldSet key={sourceKey(group.head)} className="gap-1">
          <FieldLegend variant="label" className="text-xs font-normal text-muted-foreground">{`${sourceName(t, group.head)} · ${agentsLine(t, [...new Set(group.items.map(item => item.harness))])}`}</FieldLegend>
          {group.items.map(item => {
            const key = sourceKey(item)
            return <Label key={key} className={cn('flex items-center gap-2.5 rounded-lg px-2 py-1.5 font-normal', item.added ? 'text-muted-foreground' : 'hover:bg-muted')}>
              <Checkbox checked={item.added || picked.has(key)} disabled={item.added}
                onCheckedChange={checked => setPicked(current => { const next = new Set(current); if (checked) next.add(key); else next.delete(key); return next })} />
              {/* One row is one model on one Agent (Harness draft): a key both Agents run lists its model twice. */}
              <span className="min-w-0 truncate">{item.model}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{harnessName(item.harness)}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">{item.added ? t('added') : null}</span>
            </Label>
          })}
        </FieldSet>)}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onClose([])}>{commonT('cancel')}</Button>
        <Button type="button" disabled={!chosen.length} onClick={() => onClose(chosen)}>{t('addCount', { count: chosen.length })}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
