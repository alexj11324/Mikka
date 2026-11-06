'use client'

import { useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { SearchInput } from '@/components/ui/search-input'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { groupByModelFamily, modelDisplayName } from '@/lib/model-display-name'
import { useEnabledModels, type ModelSourceKind } from '@/lib/enabled-models'
import { cn } from '@/lib/utils'

export interface EnabledModelsSource {
  id: string
  kind: ModelSourceKind
  /** The dialog's title: the account, or the key's name and last four. */
  title: string
  models: readonly string[]
  /** The key was refused (Key 无效或已撤销): the list is the last one it gave, read only. */
  invalid?: boolean
  /** The last refresh failed: the list is from `refreshedAt`. */
  refreshFailed?: string | null
  onRefresh?: () => void
  onReplaceKey?: () => void
}

/**
 * 启用的模型 for one subscription, API key or Mikka 额度 (design 2026-11-06,
 * full pages in docs/design/enabled-models/full). Switches save at once; 完成 closes.
 */
export function EnabledModelsDialog({ source, onClose }: { source: EnabledModelsSource; onClose: () => void }) {
  const t = useTranslations('Settings.enabledModels')
  const store = useEnabledModels()
  const [query, setQuery] = useState('')
  const fresh = new Set(store.fresh(source.id, source.kind, source.models))
  const enabled = store.enabled(source.id, source.kind, source.models)
  const shown = groupByModelFamily(source.models.filter(model => {
    const q = query.trim().toLowerCase()
    return !q || model.toLowerCase().includes(q) || modelDisplayName(model).name.toLowerCase().includes(q)
  }), model => model)
  const groups: { family: string; models: string[] }[] = []
  for (const model of shown) {
    const family = modelDisplayName(model).family ?? t('other')
    const last = groups.at(-1)
    if (last?.family === family) last.models.push(model)
    else groups.push({ family, models: [model] })
  }
  const all = enabled.length === source.models.length
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent className="gap-4 sm:max-w-md" data-slot="enabled-models-dialog">
      <DialogHeader><DialogTitle className="truncate">{source.title}</DialogTitle></DialogHeader>
      {source.invalid && <Alert variant="destructive"><AlertTitle>{t('invalid')}</AlertTitle></Alert>}
      {source.refreshFailed && <div role="status" className="flex items-center gap-2 text-sm text-warning-foreground">
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-warning" />{t('refreshFailed', { time: source.refreshFailed })}
        <Button type="button" variant="ghost" size="xs" className="ml-auto" onClick={source.onRefresh}>{t('retry')}</Button>
      </div>}
      {source.models.length === 0
        ? !source.invalid && <EmptyModels onAdd={model => store.set(source.id, model, true)} />
        : <>
          <div className="flex items-center gap-2">
            <SearchInput aria-label={t('search')} placeholder={t('search')} value={query} onChange={event => setQuery(event.target.value)} className="flex-1" />
            {source.kind === 'api_key' && source.onRefresh && <Button type="button" variant="ghost" size="sm" onClick={source.onRefresh}>{t('refresh')}</Button>}
          </div>
          <div className={cn('flex max-h-[min(60vh,32rem)] flex-col overflow-y-auto rounded-xl border border-border', source.invalid && 'opacity-60')}>
            <Label className="flex items-center gap-2.5 border-b border-border px-3 py-2.5 font-medium">
              <Checkbox checked={all} disabled={source.invalid} onCheckedChange={checked => store.setAll(source.id, source.models, checked === true)} />
              {t('all')}
              <span className="ml-auto text-xs font-normal text-muted-foreground tabular-nums">{enabled.length}/{source.models.length}</span>
            </Label>
            {groups.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t('noMatch', { query: query.trim() })}</p>}
            {groups.map(group => <div key={group.family} className="flex flex-col pb-1">
              <span className="px-3 pt-2.5 pb-1 text-xs font-medium text-muted-foreground">{group.family}</span>
              {group.models.map(model => <Label key={model} className="flex items-center gap-2 px-3 py-1.5 font-normal">
                <span className="min-w-0 truncate" title={model}>{modelDisplayName(model).name}</span>
                {fresh.has(model) && <Badge variant="secondary">{t('new')}</Badge>}
                <Switch className="ml-auto" checked={store.isEnabled(source.id, source.kind, source.models, model)} disabled={source.invalid}
                  aria-label={modelDisplayName(model).name} onCheckedChange={checked => store.set(source.id, model, checked)} />
              </Label>)}
            </div>)}
          </div>
          {!source.invalid && <Label className="flex items-center gap-2 font-normal text-muted-foreground">
            {t(source.kind === 'subscription' ? 'autoEnableVersions' : 'autoEnableNew')}
            <Switch className="ml-auto" checked={store.autoEnable(source.id, source.kind)} onCheckedChange={checked => store.setAutoEnable(source.id, checked)} />
          </Label>}
        </>}
      <DialogFooter>
        {source.invalid && source.onReplaceKey && <Button type="button" variant="outline" onClick={source.onReplaceKey}>{t('replaceKey')}</Button>}
        <Button type="button" onClick={onClose}>{t('done')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

function EmptyModels({ onAdd }: { onAdd: (model: string) => void }): ReactNode {
  const t = useTranslations('Settings.enabledModels')
  const [model, setModel] = useState('')
  return <div className="flex flex-col items-center gap-3 rounded-xl border border-border px-4 py-6">
    <span className="text-sm font-medium">{t('empty')}</span>
    <div className="flex w-full gap-2">
      <SearchInput aria-label={t('modelId')} placeholder={t('modelId')} className="flex-1" value={model} onChange={event => setModel(event.target.value)} />
      <Button type="button" variant="secondary" disabled={!model.trim()} onClick={() => { onAdd(model.trim()); setModel('') }}>{t('add')}</Button>
    </div>
  </div>
}

/** 「4/22 个模型 ›」: a credential row's way into its 启用的模型. */
export function EnabledModelsButton({ source, onOpen }: { source: Pick<EnabledModelsSource, 'id' | 'kind' | 'models'>; onOpen: () => void }) {
  const t = useTranslations('Settings.enabledModels')
  const store = useEnabledModels()
  const fresh = store.fresh(source.id, source.kind, source.models).length
  return <span className="inline-flex items-center gap-1.5">
    <Button type="button" variant="ghost" size="xs" className="-mx-1.5 h-6 px-1.5 font-normal text-foreground" data-slot="enabled-models-button" onClick={onOpen}>
      {t('count', { on: store.enabled(source.id, source.kind, source.models).length, total: source.models.length })}<span aria-hidden="true">›</span>
    </Button>
    {fresh > 0 && <Badge variant="secondary">{t('freshCount', { count: fresh })}</Badge>}
  </span>
}
