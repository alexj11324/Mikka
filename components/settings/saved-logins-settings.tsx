'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useLocale, useTranslations } from 'next-intl'
import { deleteSavedLogin, listSavedLoginUsage, listSavedLogins } from '@/app/actions/settings-activity'
import type { SavedLogin, SavedLoginUse } from '@/lib/settings/saved-logins'
import { Link } from '@/i18n/navigation'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SettingRow, SettingsLoading, SettingsSection } from '@/components/settings/primitives'
import { relativeTime } from '@/lib/relative-time'
import { useActionError } from '@/lib/use-action-error'
import { FieldError } from '@/components/ui/field'

/** V07: the site logins the broker may fill, and exactly where each was last used. */
export function SavedLoginsSettings() {
  const t = useTranslations('Settings.logins')
  const actionError = useActionError()
  const locale = useLocale()
  const { data, error, isLoading, mutate } = useSWR('account:saved-logins', listSavedLogins)
  const [removing, setRemoving] = useState<SavedLogin | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [usageOf, setUsageOf] = useState<SavedLogin | null>(null)

  const logins = data && !('error' in data) ? data.logins : []

  async function remove() {
    if (!removing) return
    setDeleting(true)
    setDeleteError(null)
    try {
      const result = await deleteSavedLogin(removing.id)
      if (result.error) { setDeleteError(actionError(result.error)); return }
      setRemoving(null)
      void mutate()
    } catch {
      setDeleteError(actionError())
    } finally {
      setDeleting(false)
    }
  }

  return <>
    <SettingsSection id="saved-logins-heading" title={t('heading')}>
      {isLoading && <SettingsLoading label={t('loading')} rows={3} bare />}
      {error && <FieldError className="px-5 py-3">{t('loadError')}</FieldError>}
      {!isLoading && !error && logins.length === 0 && <div className="flex flex-col items-start gap-3 px-5 py-6">
        <p className="text-sm text-muted-foreground">{t('emptyHow')}</p>
        <Button variant="secondary" size="sm" nativeButton={false} render={<Link href="/" />}><Plus data-icon="inline-start" />{t('add')}</Button>
      </div>}
      {logins.map(login => <SettingRow key={login.id} title={withoutScheme(login.site)} description={[login.account, login.lastUsedAt ? t('lastUsedBy', { when: relativeTime(login.lastUsedAt, locale), bot: login.lastUsedBy ?? t('unknownBot') }) : t('never')].join(' · ')}>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setUsageOf(login)}>{t('usage')}</Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => { setDeleteError(null); setRemoving(login) }}>{t('delete')}</Button>
        </div>
      </SettingRow>)}
    </SettingsSection>

    <Dialog open={Boolean(removing)} onOpenChange={open => { if (!open) setRemoving(null) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('deleteTitle', { site: removing ? withoutScheme(removing.site) : '' })}</DialogTitle>
          <DialogDescription>{t('deleteBody')}</DialogDescription>
        </DialogHeader>
        {deleteError && <FieldError>{deleteError}</FieldError>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={deleting} onClick={() => setRemoving(null)}>{t('cancel')}</Button>
          <Button type="button" variant="destructive" disabled={deleting} onClick={() => { void remove() }}>{deleting ? t('deleting') : t('delete')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={Boolean(usageOf)} onOpenChange={open => { if (!open) setUsageOf(null) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('usageTitle', { site: usageOf ? withoutScheme(usageOf.site) : '' })}</DialogTitle>
        </DialogHeader>
        {usageOf && <UsageList id={usageOf.id} />}
      </DialogContent>
    </Dialog>
  </>
}

function UsageList({ id }: { id: string }) {
  const t = useTranslations('Settings.logins')
  const locale = useLocale()
  const { data, error, isLoading } = useSWR(['account:saved-login-usage', id], () => listSavedLoginUsage(id))
  const uses: SavedLoginUse[] = data && !('error' in data) ? data.uses : []
  if (isLoading) return <SettingsLoading label={t('usageLoading')} rows={2} bare />
  if (error) return <FieldError>{t('usageError')}</FieldError>
  if (uses.length === 0) return <p className="text-sm text-muted-foreground">{t('usageEmpty')}</p>
  return <div className="flex max-h-80 flex-col divide-y divide-border overflow-auto">
    {uses.map(use => <div key={use.id} className="flex flex-col gap-0.5 py-2.5">
      <span className="text-sm">{use.botName ?? t('unknownBot')} · {t(`result.${use.result}`)}</span>
      <span className="text-xs text-muted-foreground">{relativeTime(use.at, locale)}</span>
    </div>)}
  </div>
}

function withoutScheme(site: string): string {
  return site.replace(/^https?:\/\//, '')
}
