'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { Circle, CircleCheck, X } from 'lucide-react'
import { dismissSetupChecklist, setupChecklist } from '@/app/actions/onboarding'
import { Button } from '@/components/ui/button'
import { bridgeFromWindow, type MikkaWindow } from '@/lib/platform/detect'
import { settingsHref, type SettingsSectionId } from '@/lib/settings-sections'
import { setupChecklistShown, visibleSetupItems, type SetupItem } from '@/lib/setup-checklist'
import { withBasePath } from '@/lib/base-path'
import { cn } from '@/lib/utils'

const ACTIONS: Partial<Record<SetupItem, SettingsSectionId>> = { model: 'models', device: 'computers', app: 'connections', invite: 'members' }

/**
 * Capy's setup guide after the first-run guide (decision 2026-11-15-1900 rule 8):
 * what is left to set up, under 新建任务's text. Each item's state is read from
 * what exists; the person can hide it, per workspace.
 */
export function SetupChecklist({ workspaceId }: { workspaceId: string | null | undefined }) {
  const t = useTranslations('SetupChecklist')
  const [desktop, setDesktop] = useState(false)
  useEffect(() => { setDesktop(Boolean(bridgeFromWindow(window as MikkaWindow))) }, [])
  const list = useSWR(workspaceId ? ['setup-checklist', workspaceId] : null, () => setupChecklist(workspaceId!), { revalidateOnFocus: false })
  if (!workspaceId || !setupChecklistShown(list.data, desktop)) return null
  const items = visibleSetupItems(list.data!, desktop)
  const left = items.filter(item => !list.data!.done[item]).length
  return <section aria-label={t('title')} className="flex flex-col gap-2 rounded-lg border p-3">
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm font-medium">{t('title')}</span>
      <span className="flex items-center gap-1">
        <span className="text-xs text-muted-foreground">{t('left', { count: left })}</span>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t('hide')} onClick={() => {
          void list.mutate({ ...list.data!, dismissed: true }, { revalidate: false })
          void dismissSetupChecklist(workspaceId).catch(() => { void list.mutate() })
        }}><X aria-hidden="true" /></Button>
      </span>
    </div>
    <ul className="flex flex-col gap-1">
      {items.map(item => {
        const done = Boolean(list.data!.done[item])
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
