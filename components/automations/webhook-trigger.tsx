'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Copy } from '@/components/icons'
import { automationWebhookKey } from '@/app/actions/automations'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/settings/primitives'
import { useActionError } from '@/lib/use-action-error'
import { publicServiceLink } from '@/lib/platform/public-origin'
import type { AutomationView } from '@/lib/schedules/automation-view'

const BATCH_MINUTES = [0, 1, 5, 15, 60] as const

/**
 * 满足任一条件就运行's Webhook row (decision 2026-11-15-1830): a POST to the automation's own URL starts a run, and
 * requests within the chosen minutes go to one run. The URL is shown once, right after it is made; making a new one
 * stops the old one. A new or unsaved automation is saved first.
 */
export function WebhookTrigger({ value, onChange, automation, onSaved, disabled }: {
  value: number | null; onChange: (next: number | null) => void; automation: AutomationView | null
  onSaved: (schedule: AutomationView) => Promise<unknown>; disabled?: boolean
}) {
  const t = useTranslations('Automations.editor.webhook')
  const actionError = useActionError()
  const [url, setUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const saved = Boolean(automation?.definition.webhook)
  async function generate() {
    if (!automation || busy) return
    setBusy(true)
    try {
      const result = await automationWebhookKey({ scheduleId: automation.id, version: automation.version }, automation.workspace_id ?? undefined)
      if ('error' in result && result.error) { toast.error(actionError(result.error)); return }
      const { schedule, key } = result as { schedule: AutomationView; key: string }
      setUrl(publicServiceLink(`/api/webhooks/automations/${key}`))
      await onSaved({ ...automation, ...schedule })
    } finally { setBusy(false) }
  }
  async function copy() {
    if (!url) return
    try { await navigator.clipboard.writeText(url); toast.success(t('copied')) } catch { toast.error(t('copyFailed')) }
  }
  return <>
    <SettingRow title={t('title')} description={t('description')}>
      <Switch aria-label={t('title')} checked={value !== null} disabled={disabled} onCheckedChange={on => onChange(on ? 0 : null)} />
    </SettingRow>
    {value !== null && <div className="flex flex-col gap-3 px-5 pb-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t('batch')}</span>
        <NativeSelect aria-label={t('batch')} value={String(value)} disabled={disabled} onChange={event => onChange(Number(event.target.value))}>
          {BATCH_MINUTES.map(minutes => <NativeSelectOption key={minutes} value={minutes}>{minutes ? t('batchMinutes', { minutes }) : t('batchNone')}</NativeSelectOption>)}
        </NativeSelect>
      </div>
      {url
        ? <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Input readOnly aria-label={t('url')} value={url} dir="ltr" className="min-w-0 flex-1 font-mono text-xs" onFocus={event => event.currentTarget.select()} />
            <Button size="icon-sm" variant="ghost" aria-label={t('copy')} onClick={() => { void copy() }}><Copy /></Button>
          </div>
          <p className="text-sm text-muted-foreground">{t('once')}</p>
        </div>
        : !saved
          ? <p className="text-sm text-muted-foreground">{t('saveFirst')}</p>
          : <div className="flex flex-wrap items-center gap-2 text-sm">
            {automation?.webhook_key_set && <span className="text-muted-foreground">{t('made')}</span>}
            <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => { void generate() }}>{automation?.webhook_key_set ? t('remake') : t('make')}</Button>
          </div>}
    </div>}
  </>
}
