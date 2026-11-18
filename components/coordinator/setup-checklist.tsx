'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from '@/lib/intl/i18n-client'
import useSWR from 'swr'
import { Circle, CircleCheck, X } from 'lucide-react'
import { dismissSetupChecklist, restoreSetupChecklist, setupChecklist } from '@/app/actions/onboarding'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { FieldError } from '@/components/ui/field'
import { useActionError } from '@/lib/use-action-error'
import { Button } from '@/components/ui/button'
import { bridgeFromWindow, type MikkaWindow } from '@/lib/platform/detect'
import { settingsHref, type SettingsSectionId } from '@/lib/settings-sections'
import { readSetupChecklist, setupChecklistShown, visibleSetupItems, type SetupItem } from '@/lib/setup-checklist'
import { withBasePath } from '@/lib/base-path'
import { cn } from '@/lib/utils'

const ACTIONS: Partial<Record<SetupItem, SettingsSectionId>> = { model: 'models', device: 'computers', app: 'connections', invite: 'members' }

function useChecklist(workspaceId: string | null | undefined) {
  return useSWR(workspaceId ? ['setup-checklist', workspaceId] : null, () => setupChecklist(workspaceId!), { revalidateOnFocus: false })
}

/**
 * Capy's setup guide after the first-run guide (decision 2026-11-15-1900 rule 8):
 * what is left to set up, under 新建任务's text. Each item's state is read from
 * what exists; the person can hide it, per workspace.
 */
export function SetupChecklist({ workspaceId }: { workspaceId: string | null | undefined }) {
  const t = useTranslations('SetupChecklist')
  const [desktop, setDesktop] = useState(false)
  useEffect(() => { setDesktop(Boolean(bridgeFromWindow(window as MikkaWindow))) }, [])
  const list = useChecklist(workspaceId)
  const data = readSetupChecklist(list.data)
  if (!workspaceId || !data || !setupChecklistShown(data, desktop)) return null
  const items = visibleSetupItems(data, desktop)
  const left = items.filter(item => !data.done[item]).length
  return <section aria-label={t('title')} className="flex flex-col gap-2 rounded-lg border p-3">
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm font-medium">{t('title')}</span>
      <span className="flex items-center gap-1">
        <span className="text-xs text-muted-foreground">{t('left', { count: left })}</span>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t('hide')} onClick={() => {
          void list.mutate({ ...data, dismissed: true }, { revalidate: false })
          void dismissSetupChecklist(workspaceId).catch(() => { void list.mutate() })
        }}><X aria-hidden="true" /></Button>
      </span>
    </div>
    <ul className="flex flex-col gap-1">
      {items.map(item => {
        const done = Boolean(data.done[item])
        const section = ACTIONS[item]
        return <li key={item} className="flex items-center gap-2 text-sm">
          {done ? <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-primary" /> : <Circle aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
          <span className={cn('min-w-0 flex-1 truncate', done && 'text-muted-foreground line-through')}>{t(`items.${item}`)}</span>
          {!done && section && <a className="text-xs text-muted-foreground underline-offset-4 hover:underline" href={withBasePath(settingsHref(section, workspaceId))}>{t(`actions.${item as Exclude<SetupItem, 'task'>}`)}</a>}
        </li>
      })}
    </ul>
  </section>
}

/** Preferences is still reachable after the user hides the New Task checklist. */
export function RestoreSetupChecklist({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('SetupChecklist'), common = useTranslations('Common')
  const actionError = useActionError()
  const list = useChecklist(workspaceId)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  if (!readSetupChecklist(list.data)?.dismissed) return null

  async function restore() {
    setSaving(true)
    setFailed(false)
    try {
      await list.mutate(async () => {
        await restoreSetupChecklist(workspaceId)
        return setupChecklist(workspaceId)
      }, { revalidate: false })
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }
  return <SettingsSection id="restore-setup-checklist">
    <SettingRow title={t('title')}>
      <Button type="button" variant="secondary" size="sm" disabled={saving} onClick={() => void restore()}>
        {saving ? common('saving') : t('show')}
      </Button>
    </SettingRow>
    {failed && <FieldError>{actionError()}</FieldError>}
  </SettingsSection>
}
