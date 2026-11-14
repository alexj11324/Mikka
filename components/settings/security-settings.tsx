'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SettingRow, SettingsLoading, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { relativeTime } from '@/lib/relative-time'
import { FieldError } from '@/components/ui/field'
import { useSecurity } from '@/hooks/settings/use-security'

/** N1: password, signed-in devices. Passkey and 2FA wait for their backend. */
export function SecuritySettings() {
  const t = useTranslations('Settings.security')
  const commonT = useTranslations('Common')
  const locale = useLocale()
  const security = useSecurity()
  const { passwordError, hasPassword, devices, pendingSession, signOutError } = security
  const [editing, setEditing] = useState(false)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [revokeOthers, setRevokeOthers] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const mismatch = Boolean(next) && next !== again

  function open() {
    setCurrent(''); setNext(''); setAgain(''); setSaveError(null); setEditing(true)
  }

  async function save() {
    if (mismatch) return
    setSaving(true)
    setSaveError(null)
    try {
      const error = await security.savePassword({ current, next, revokeOthers })
      if (error) { setSaveError(error); return }
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return <>
    <SettingsSection id="password-heading" title={t('signInMethods')}>
      <SettingRow title={t('password')} description={hasPassword === false ? t('passwordNotSet') : undefined}>
        {hasPassword !== null && <Button type="button" variant="secondary" size="sm" disabled={security.passwordLoading} onClick={open}>
          {hasPassword ? t('changePassword') : t('setPassword')}
        </Button>}
      </SettingRow>
      {security.passwordLoading && <SettingsLoading label={commonT('loading')} rows={1} bare />}
      {passwordError && <SettingsSaveError message={passwordError} retryLabel={commonT('retry')} onRetry={() => { void security.reloadPassword() }} />}
    </SettingsSection>

    <SettingsSection id="devices-heading" title={t('devices')}>
      {security.devicesError !== null && <SettingsSaveError message={security.devicesError || t('devicesError')} retryLabel={commonT('retry')} onRetry={() => { void security.reloadDevices() }} />}
      {security.devicesLoading && <SettingsLoading label={t('devicesLoading')} rows={3} bare />}
      {devices.map(device => <SettingRow key={device.id} title={device.label ?? t('unknownDevice')} description={t('lastActive', { when: relativeTime(device.lastActiveAt, locale) })}>
        {device.current
          ? <Badge variant="secondary">{t('currentDevice')}</Badge>
          : <Button type="button" variant="secondary" size="sm" disabled={pendingSession !== null} onClick={() => { void security.signOut(device.id) }}>{pendingSession === device.id ? t('signingOut') : t('signOut')}</Button>}
      </SettingRow>)}
      {devices.length > 1 && <SettingRow title={t('otherDevices')}>
        <Button type="button" variant="secondary" size="sm" disabled={pendingSession !== null} onClick={() => { void security.signOutOthers() }}>{t('signOutOthers')}</Button>
      </SettingRow>}
      {signOutError && <FieldError className="px-5 py-3">{signOutError}</FieldError>}
    </SettingsSection>

    <Dialog open={editing} onOpenChange={setEditing}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{hasPassword ? t('changePassword') : t('setPassword')}</DialogTitle>
        </DialogHeader>
        {/* R-33: 16px between fields, 6px from a label to its input. */}
        <div className="flex flex-col gap-4">
          {hasPassword && <Label className="flex flex-col items-start gap-1.5">{t('currentPassword')}
            <Input type="password" autoComplete="current-password" value={current} onChange={event => setCurrent(event.target.value)} />
          </Label>}
          <Label className="flex flex-col items-start gap-1.5">{t('newPassword')}
            <Input type="password" autoComplete="new-password" value={next} onChange={event => setNext(event.target.value)} />
          </Label>
          <Label className="flex flex-col items-start gap-1.5">{t('confirmPassword')}
            <Input type="password" autoComplete="new-password" value={again} onChange={event => setAgain(event.target.value)} />
          </Label>
          {mismatch && <FieldError>{t('passwordMismatch')}</FieldError>}
          {hasPassword && <Label className="flex items-center gap-2">
            <Checkbox checked={revokeOthers} onCheckedChange={checked => setRevokeOthers(checked === true)} />
            {t('revokeOthers')}
          </Label>}
          {saveError && <FieldError>{saveError}</FieldError>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setEditing(false)} disabled={saving}>{t('cancel')}</Button>
          <Button type="button" disabled={saving || hasPassword === null || !next || mismatch || (hasPassword && !current)} onClick={() => { void save() }}>{saving ? t('saving') : t('save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
