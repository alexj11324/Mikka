'use client'

import { useEffect, useState } from 'react'
import { Check, Loader2, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { ComputerDoctor, ComputerPermissionState } from '@mikka/protocol/computer'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field'
import { bridgeFromWindow, type MikkaWindow } from '@/lib/platform/detect'

/** granted / denied / unknown, as a short value the person can scan. */
function PermissionValue({ state }: { state: ComputerPermissionState }) {
  const t = useTranslations('Devices.localComputerUse')
  if (state === 'granted')
    return <span className="flex items-center gap-1.5 text-sm"><Check aria-hidden="true" className="size-4 text-success-foreground" />{t('state.granted')}</span>
  if (state === 'denied')
    return <span className="flex items-center gap-1.5 text-sm"><X aria-hidden="true" className="size-4 text-destructive-foreground" />{t('state.denied')}</span>
  return <span className="text-sm text-muted-foreground">{t('state.unknown')}</span>
}

/**
 * 设置 › 设备 › 本机电脑操作: the state of local computer use on this Mac and
 * the one click that enables it. Only the desktop build on macOS draws it;
 * the grant must be a person's click in the GUI session, never a run or a
 * launch agent. The daemon owns the driver and still gives a run only the
 * request-only proxy.
 */
export function LocalComputerUse() {
  const t = useTranslations('Devices.localComputerUse')
  const [available, setAvailable] = useState(false)
  const [doctor, setDoctor] = useState<ComputerDoctor | null>(null)
  const [loading, setLoading] = useState(true)
  const [granting, setGranting] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const bridge = bridgeFromWindow(window as MikkaWindow)
    const read = bridge?.device?.computerPermissions
    if (document.documentElement.dataset.desktopPlatform !== 'darwin' || !read) return
    setAvailable(true)
    let live = true
    void read()
      .then(next => {
        if (!live) return
        // Null: no daemon, or one older than the RPC. Keep the section out.
        if (!next) return setAvailable(false)
        setDoctor(next)
      })
      .catch(() => { if (live) setFailed(true) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [])

  if (!available) return null

  const run = async (grant: boolean) => {
    const bridge = bridgeFromWindow(window as MikkaWindow)
    const request = grant ? bridge?.device?.grantComputerPermissions : bridge?.device?.computerPermissions
    if (!request || granting) return
    setGranting(true)
    setFailed(false)
    try {
      const next = await request()
      if (next) setDoctor(next)
      else setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      setGranting(false)
    }
  }

  const status = doctor?.probe.status
  const statusText = doctor
    ? doctor.probe.status === 'binary_version' && !doctor.version
      ? t('status.binaryVersionUnknown')
      : t(`status.${doctor.probe.status}`, { version: doctor.version ?? '' })
    : t('statusLabel')
  // Nothing to request when the pinned driver is absent: install it first,
  // then 重新检查 (which also re-detects it in the running daemon).
  const canGrant = doctor?.installed === true && status !== 'ok'
  const action = !doctor || loading
    ? null
    : canGrant
      ? <Button size="sm" variant="secondary" disabled={granting} onClick={() => { void run(true) }}>
        {granting ? <><Loader2 data-icon="inline-start" aria-hidden="true" className="animate-spin motion-reduce:animate-none" />{t('enabling')}</> : t('enable')}
      </Button>
      : <Button size="sm" variant="secondary" disabled={granting} onClick={() => { void run(false) }}>{t('recheck')}</Button>

  return <SettingsSection id="local-computer-use-heading" title={t('title')} description={t('description')} action={action}>
    <SettingRow title={t('driver')} description={doctor?.binaryPath ?? undefined}>
      {!doctor
        ? <span className="flex items-center gap-1.5 text-sm text-muted-foreground"><Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />{t('checking')}</span>
        : doctor.installed
          ? <span className="text-sm">{doctor.version}</span>
          : <span className="text-sm text-destructive-foreground">{t('notInstalled')}</span>}
    </SettingRow>
    <SettingRow title={t('accessibility')}>{doctor && <PermissionValue state={doctor.accessibility} />}</SettingRow>
    <SettingRow title={t('screenRecording')}>{doctor && <PermissionValue state={doctor.screenRecording} />}</SettingRow>
    <SettingRow title={t('captureConsent')}>{doctor && <PermissionValue state={doctor.captureConsent} />}</SettingRow>
    <SettingRow title={t('statusLabel')} description={statusText}>
      {doctor && status !== 'ok' && !canGrant && <span className="text-sm text-muted-foreground">{t('installHint')}</span>}
    </SettingRow>
    {granting && <SettingRow title={t('grantingLabel')} description={t('grantingDescription')} />}
    {failed && <SettingRow title={t('errorTitle')}><FieldError>{t('error')}</FieldError></SettingRow>}
  </SettingsSection>
}
