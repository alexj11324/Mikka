'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SettingRow, SettingsLoading, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { FieldError } from '@/components/ui/field'
import { usePrivacy } from '@/hooks/settings/use-privacy'

/** N2: the data export, and every link that currently opens one of my artifacts. */
export function PrivacySettings() {
  const t = useTranslations('Settings.privacy')
  const commonT = useTranslations('Common')
  const { exporting, exportMessage, exportError, downloadPath, exportData, shared, total, readFailure: readMessage, reload, stopping, stopError, stop } = usePrivacy()
  const [managing, setManaging] = useState(false)
  const readError = readMessage !== null
  const readFailure = readMessage !== null ? <SettingsSaveError message={readMessage} retryLabel={commonT('retry')} onRetry={reload} /> : null

  return <>
    <SettingsSection id="export-heading" title={t('data')}>
      <SettingRow title={t('export')}>
        <Button type="button" variant="secondary" size="sm" disabled={exporting} onClick={() => { void exportData() }}>{exporting ? t('exporting') : t('exportButton')}</Button>
      </SettingRow>
      {exportMessage && <p role="status" className="px-5 pb-3 text-sm text-muted-foreground">
        {exportMessage}
        {downloadPath && <> <a href={downloadPath} download className="font-medium text-foreground underline underline-offset-4">{t('exportDownload')}</a></>}
      </p>}
      {exportError && <FieldError className="px-5 pb-3">{exportError}</FieldError>}
    </SettingsSection>

    <SettingsSection id="shared-heading" title={t('sharing')}>
      <SettingRow title={t('sharedLinks')} description={shared ? total > 0 ? t('sharedLinksCount', { count: total }) : t('sharedLinksNone') : undefined}>
        <span title={shared && total === 0 ? t('manageNone') : undefined}>
          <Button type="button" variant="secondary" size="sm" disabled={!shared || total === 0} onClick={() => setManaging(true)}>{t('manage')}</Button>
        </span>
      </SettingRow>
      {!shared && !readError && <SettingsLoading label={t('linksLoading')} rows={1} bare />}
      {readFailure}
    </SettingsSection>

    <Dialog open={managing} onOpenChange={setManaging}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('sharedLinks')}</DialogTitle>
        </DialogHeader>
        {!shared && !readError && <SettingsLoading label={t('linksLoading')} rows={2} bare />}
        {shared?.length === 0 && <p className="text-sm text-muted-foreground">{t('sharedLinksNone')}</p>}
        <div className="flex flex-col divide-y divide-border">
          {shared?.map(link => <div key={link.artifactId} className="flex items-center justify-between gap-3 py-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-sm font-medium">{link.title}</span>
              <span className="text-xs text-muted-foreground">{t('links', { count: link.links })}</span>
            </div>
            <Button type="button" variant="secondary" size="sm" disabled={stopping !== null} onClick={() => { void stop(link.artifactId) }}>
              {stopping === link.artifactId ? t('stopping') : t('stopSharing')}
            </Button>
          </div>)}
        </div>
        {readFailure}
        {stopError && <FieldError>{stopError}</FieldError>}
      </DialogContent>
    </Dialog>
  </>
}
