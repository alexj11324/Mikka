'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useLocale, useTranslations } from 'next-intl'
import { changePassword, revokeOtherSessions, revokeSession, setPassword, type getPasswordStatus, type listSessions } from '@/app/actions/account'
import { settingsRead } from '@/lib/settings-read'
import type { SignedInDevice } from '@/lib/account/sessions'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SettingRow, SettingsLoading, SettingsSection } from '@/components/settings/primitives'
import { relativeTime } from '@/lib/relative-time'
import { useActionError } from '@/lib/use-action-error'
import { FieldError } from '@/components/ui/field'

/** N1: password, signed-in devices. Passkey and 2FA wait for their backend. */
export function SecuritySettings() {
  const t = useTranslations('Settings.security')
  const actionError = useActionError()
  const locale = useLocale()
  const password = useSWR('account:password', () => settingsRead<Awaited<ReturnType<typeof getPasswordStatus>>>('password'))
  const sessions = useSWR('account:sessions', () => settingsRead<Awaited<ReturnType<typeof listSessions>>>('sessions'))
  const [editing, setEditing] = useState(false)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [revokeOthers, setRevokeOthers] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [pendingSession, setPendingSession] = useState<string | null>(null)
  const [signOutError, setSignOutError] = useState<string | null>(null)

  const passwordStatus = password.data && !('error' in password.data) ? password.data : null
  const passwordError = password.data && 'error' in password.data ? actionError(password.data.error) : null
  const hasPassword = passwordStatus?.hasPassword ?? false
  const mismatch = Boolean(next) && next !== again

  function open() {
    setCurrent(''); setNext(''); setAgain(''); setSaveError(null); setEditing(true)
  }

  async function save() {
    if (mismatch) return
    setSaving(true)
    setSaveError(null)
    try {
      const result = hasPassword
        ? await changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: revokeOthers })
        : await setPassword({ newPassword: next })
      if (result.error) { setSaveError(actionError(result.error)); return }
      setEditing(false)
      void password.mutate()
      void sessions.mutate()
    } catch {
      setSaveError(actionError())
    } finally {
      setSaving(false)
    }
  }

  async function signOut(sessionId: string) {
    setPendingSession(sessionId)
    setSignOutError(null)
    try {
      const result = await revokeSession(sessionId)
      if (result.error) { setSignOutError(actionError(result.error)); return }
      void sessions.mutate()
    } catch {
      setSignOutError(actionError())
    } finally {
      setPendingSession(null)
    }
  }

  async function signOutEverywhere() {
    setPendingSession('all')
    setSignOutError(null)
    try {
      const result = await revokeOtherSessions()
      if (result.error) { setSignOutError(actionError(result.error)); return }
      void sessions.mutate()
    } catch {
      setSignOutError(actionError())
    } finally {
      setPendingSession(null)
    }
  }

  const devices: SignedInDevice[] = sessions.data && !('error' in sessions.data) ? sessions.data.sessions : []

  return <>
    <SettingsSection id="password-heading" title={t('signInMethods')}>
      <SettingRow title={t('password')} description={passwordError ?? (hasPassword ? undefined : t('passwordNotSet'))}>
        <Button type="button" variant="secondary" size="sm" disabled={password.isLoading} onClick={open}>
          {hasPassword ? t('changePassword') : t('setPassword')}
        </Button>
      </SettingRow>
    </SettingsSection>

    <SettingsSection id="devices-heading" title={t('devices')}>
      {(sessions.error || (sessions.data && 'error' in sessions.data)) && <FieldError className="px-5 py-3">{sessions.data && 'error' in sessions.data ? actionError(sessions.data.error) : t('devicesError')}</FieldError>}
      {!sessions.data && !sessions.error && <SettingsLoading label={t('devicesLoading')} rows={3} bare />}
      {devices.map(device => <SettingRow key={device.id} title={device.label ?? t('unknownDevice')} description={t('lastActive', { when: relativeTime(device.lastActiveAt, locale) })}>
        {device.current
          ? <Badge variant="secondary">{t('currentDevice')}</Badge>
          : <Button type="button" variant="secondary" size="sm" disabled={pendingSession !== null} onClick={() => { void signOut(device.id) }}>{pendingSession === device.id ? t('signingOut') : t('signOut')}</Button>}
      </SettingRow>)}
      {devices.length > 1 && <SettingRow title={t('signOutOthers')}>
        <Button type="button" variant="secondary" size="sm" disabled={pendingSession !== null} onClick={() => { void signOutEverywhere() }}>{t('signOutOthers')}</Button>
      </SettingRow>}
      {signOutError && <FieldError className="px-5 py-3">{signOutError}</FieldError>}
    </SettingsSection>

    <Dialog open={editing} onOpenChange={setEditing}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{hasPassword ? t('changePassword') : t('setPassword')}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
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
          <Button type="button" disabled={saving || !next || mismatch || (hasPassword && !current)} onClick={() => { void save() }}>{saving ? t('saving') : t('save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
