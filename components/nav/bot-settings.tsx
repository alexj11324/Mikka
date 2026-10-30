'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { getBotSettings, updateBotSettings } from '@/app/actions/bots'
import { Select, SelectContent, SelectGroup, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { WorkspaceBotModel } from '@/lib/db/schema'
import { createBotSettingsSaver, type BotSettingsChange } from '@/lib/settings/bot-settings-saver'
import { Link } from '@/i18n/navigation'
import { settingsHref } from '@/lib/settings-sections'
import { useActionError } from '@/lib/use-action-error'

const NO_REPOSITORY = '__none__'

/**
 * A bot's own settings in its 详情 (docs/design/bot-settings.md): its model, from
 * the workspace's 可用模型, and its default repository, from the repositories the
 * workspace's GitHub App installations cover. Only the owner changes them.
 */
export function BotSettings({ botId }: { botId: string }) {
  const t = useTranslations('Settings.botSettings')
  const panelT = useTranslations('Shell.panel')
  const allT = useTranslations()
  const actionError = useActionError()
  const { data, mutate } = useSWR(['bot-settings', botId], async () => {
    const result = await getBotSettings({ botId })
    if (result.error) throw new Error(result.error)
    return result
  }, { revalidateOnFocus: false })
  const [values, setValues] = useState<Required<BotSettingsChange> | null>(null)

  const alive = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const saver = useRef<ReturnType<typeof createBotSettingsSaver> | null>(null)
  saver.current ??= createBotSettingsSaver({
    update: async change => {
      const result = await updateBotSettings({ botId, ...change })
      return result.error ? result : { model: result.model, repository: result.repository }
    },
    apply: patch => setValues(current => current && { ...current, ...patch }),
    onSaved: () => void mutate(),
    onFailed: (_change, error) => { toast.error(actionError(error)); void mutate() },
    isActive: () => alive.current,
  })
  useEffect(() => {
    if (!data) return
    saver.current?.confirm({ model: data.model, repository: data.repository })
    setValues({ model: data.model, repository: data.repository })
  }, [data])

  if (!data || !values) return null
  const label = (model: WorkspaceBotModel | null) => {
    const group = data.modelGroups.find(item => item.id === model)
    return group ? allT(group.labelKey) : ''
  }
  // What the menu shows: the owner's choice while it is allowed, else what the bot falls back to.
  const shownModel = values.model && data.allowedModels.includes(values.model) ? values.model : data.effectiveModel
  const shownRepository = values.repository && data.repositories.includes(values.repository) ? values.repository : NO_REPOSITORY
  const modelItems = data.allowedModels.map(model => ({ value: model, label: label(model) }))
  const repositoryItems = [{ value: NO_REPOSITORY, label: t('noRepository') }, ...data.repositories.map(value => ({ value, label: value }))]
  const save = (change: BotSettingsChange) => void saver.current?.save(change)
  // Codex and Claude run on the owner's own subscription (设置 › 模型订阅).
  const needsSubscription = data.canEdit && (shownModel === 'codex' || shownModel === 'claude') && !data.connectedProviders.includes(shownModel)

  return <section aria-label={panelT('botSettings')} className="flex flex-col rounded-2xl bg-muted/60 p-1.5" data-testid="bot-settings">
    <Row label={t('model')} note={data.modelUnavailable && values.model === data.model
      ? t('modelUnavailable', { model: label(data.model) })
      : needsSubscription ? <Link href={settingsHref('models')} className="underline-offset-4 hover:underline">{t('subscriptionMissing', { model: label(shownModel) })}</Link> : null}>
      {data.canEdit
        ? <Select items={modelItems} value={shownModel} onValueChange={value => { if (value && value !== shownModel) save({ model: value as WorkspaceBotModel }) }}>
            <SelectTrigger size="sm" className="w-32" aria-label={t('model')}><SelectValue /></SelectTrigger>
            <SelectContent align="end"><SelectGroup>{modelItems.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
          </Select>
        : label(data.effectiveModel)}
    </Row>
    <Row label={t('repository')} note={data.repositoryUnavailable && values.repository === data.repository ? t('repositoryUnavailable', { repository: data.repository ?? '' }) : null}>
      {data.canEdit
        ? <Select items={repositoryItems} value={shownRepository} onValueChange={value => {
            if (typeof value !== 'string' || value === shownRepository) return
            save({ repository: value === NO_REPOSITORY ? null : value })
          }}>
            <SelectTrigger size="sm" className="max-w-48" aria-label={t('repository')}><SelectValue /></SelectTrigger>
            <SelectContent align="end">
              <SelectGroup><SelectItem value={NO_REPOSITORY}>{t('noRepository')}</SelectItem></SelectGroup>
              {data.repositories.length > 0 && <SelectSeparator />}
              <SelectGroup>{data.repositories.map(repository => <SelectItem key={repository} value={repository}>{repository}</SelectItem>)}</SelectGroup>
            </SelectContent>
          </Select>
        : data.effectiveRepository ?? t('noRepository')}
    </Row>
  </section>
}

function Row({ label, note, children }: { label: string; note: ReactNode; children: ReactNode }) {
  return <div className="flex flex-col gap-1 px-2.5 py-1.5">
    <div className="flex min-w-0 items-center justify-between gap-3 text-sm">
      <span className="shrink-0">{label}</span>
      <span className="flex min-w-0 justify-end truncate">{children}</span>
    </div>
    {note && <p className="text-xs text-muted-foreground">{note}</p>}
  </div>
}

