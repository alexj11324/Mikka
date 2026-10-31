'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { listSharedLinks, requestDataExport } from '@/app/actions/account'
import { stopSharingArtifact } from '@/app/actions/artifacts'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SettingRow, SettingsLoading, SettingsSection } from '@/components/settings/primitives'
import { useActionError } from '@/lib/use-action-error'
import { FieldError } from '@/components/ui/field'

/** N2: the data export, and every link that currently opens one of my artifacts. */
export function PrivacySettings() {
  const t = useTranslations('Settings.privacy')
  const actionError = useActionError()
  const links = useSWR('account:shared-links', listSharedLinks)
  const [exporting, setExporting] = useState(false)
  const [exportMessage, setExportMessage] = useState<string | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const [downloadPath, setDownloadPath] = useState<string | null>(null)
  const [managing, setManaging] = useState(false)
  const [stopping, setStopping] = useState<string | null>(null)
  const [stopError, setStopError] = useState<string | null>(null)

  const shared = links.data && !('error' in links.data) ? links.data.links : []
  const total = shared.reduce((sum, link) => sum + link.links, 0)

  async function exportData() {
    setExporting(true)
    setExportMessage(null)
    setExportError(null)
    setDownloadPath(null)
    try {
      const result = await requestDataExport()
      if (result.error === 'dataExportRateLimited') {
        setExportError(t('exportWait', { minutes: result.params?.minutes ?? 0 }))
        return
      }
      if (result.error) { setExportError(actionError(result.error)); return }
      if (result.downloadPath) {
        setDownloadPath(result.downloadPath)
        setExportMessage(t('exportReady', { hours: Math.max(1, Math.round((Date.parse(result.expiresAt) - Date.now()) / 3_600_000)) }))
        return
      }
      setExportMessage(t('exportSent', { email: result.email }))
    } catch {
      setExportError(actionError())
    } finally {
      setExporting(false)
    }
  }

  async function stop(artifactId: string) {
    setStopping(artifactId)
    setStopError(null)
    try {
      const result = await stopSharingArtifact(artifactId)
      if (result.error) { setStopError(actionError(result.error)); return }
      void links.mutate()
    } catch {
      setStopError(actionError())
    } finally {
      setStopping(null)
    }
  }

  return <>
    <SettingsSection id="export-heading" title={t('data')}>
      <SettingRow title={t('export')} description={t('exportDescription')}>
        <Button type="button" variant="secondary" size="sm" disabled={exporting} onClick={() => { void exportData() }}>{exporting ? t('exporting') : t('exportButton')}</Button>
      </SettingRow>
      {exportMessage && <p role="status" className="px-5 pb-3 text-sm text-muted-foreground">
        {exportMessage}
        {downloadPath && <> <a href={downloadPath} download className="font-medium text-foreground underline underline-offset-4">{t('exportDownload')}</a></>}
      </p>}
      {exportError && <FieldError className="px-5 pb-3">{exportError}</FieldError>}
    </SettingsSection>

    <SettingsSection id="shared-heading" title={t('sharing')}>
      <SettingRow title={t('sharedLinks')} description={total > 0 ? t('sharedLinksCount', { count: total }) : t('sharedLinksNone')}>
        <span title={total === 0 ? t('manageNone') : undefined}>
          <Button type="button" variant="secondary" size="sm" disabled={total === 0 || links.isLoading} onClick={() => setManaging(true)}>{t('manage')}</Button>
        </span>
      </SettingRow>
    </SettingsSection>

    <Dialog open={managing} onOpenChange={setManaging}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('sharedLinks')}</DialogTitle>
          <DialogDescription>{t('sharedLinksDescription')}</DialogDescription>
        </DialogHeader>
        {links.isLoading && <SettingsLoading label={t('linksLoading')} rows={2} />}
        {!links.isLoading && shared.length === 0 && <p className="text-sm text-muted-foreground">{t('sharedLinksNone')}</p>}
        <div className="flex flex-col divide-y divide-border">
          {shared.map(link => <div key={link.artifactId} className="flex items-center justify-between gap-3 py-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-sm font-medium">{link.title}</span>
              <span className="text-xs text-muted-foreground">{t('links', { count: link.links })}</span>
            </div>
            <Button type="button" variant="secondary" size="sm" disabled={stopping !== null} onClick={() => { void stop(link.artifactId) }}>
              {stopping === link.artifactId ? t('stopping') : t('stopSharing')}
            </Button>
          </div>)}
        </div>
        {stopError && <FieldError>{stopError}</FieldError>}
      </DialogContent>
    </Dialog>
  </>
}
