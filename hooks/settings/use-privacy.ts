'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { listSharedLinks, requestDataExport } from '@/app/actions/account'
import { stopSharingArtifact } from '@/app/actions/artifacts'
import { useActionError } from '@/lib/use-action-error'

/**
 * 数据与隐私 (N2): the data export, and every link that currently opens one of
 * the person's artifacts. Shared by the open-source page and the hosted layer
 * (docs/ui-overlay.md).
 */
export function usePrivacy() {
  const t = useTranslations('Settings.privacy')
  const actionError = useActionError()
  const links = useSWR('account:shared-links', listSharedLinks)
  const [exporting, setExporting] = useState(false)
  const [exportMessage, setExportMessage] = useState<string | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const [downloadPath, setDownloadPath] = useState<string | null>(null)
  const [stopping, setStopping] = useState<string | null>(null)
  const [stopError, setStopError] = useState<string | null>(null)

  const shared = links.data && !('error' in links.data) ? links.data.links : undefined
  const readError = links.error || (links.data && 'error' in links.data ? links.data.error : undefined)
  /** Why the links could not be read, or null */
  const readFailure = readError ? actionError(typeof readError === 'string' ? readError : undefined) : null
  const total = shared?.reduce((sum, link) => sum + link.links, 0) ?? 0

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

  return {
    exporting, exportMessage, exportError, downloadPath, exportData,
    shared, total, readFailure, reload: () => { void links.mutate() },
    stopping, stopError, stop,
  }
}
