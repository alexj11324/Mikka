'use client'

import { useState } from 'react'
import useSWR, { unstable_serialize } from 'swr'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { FieldError } from '@/components/ui/field'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SettingRow, SettingsSection, SettingsLoading } from '@/components/settings/primitives'
import { useLiveKey } from '@/hooks/use-live-key'
import { withBasePath } from '@/lib/base-path'
import { fetchSettingsData, settingsReadOptions, SettingsReadError } from '@/lib/settings-data'
import { cloudErrorCode } from '@/lib/cloud-services/errors'
import { AVAILABLE_CLOUD_SCOPES, type CloudConnectionView, type CloudScope } from '@/lib/cloud-services/types'
import { MikkaMarkSmall } from '@/components/brand/mikka-mark'

/** Uses the established settings rows; only the current page reads its state. */
export function CloudSettings({ personal = false, userKey, workspaceId }: { personal?: boolean; userKey: string; workspaceId?: string }) {
  const t = useTranslations('Settings.cloud')
  const errors = useTranslations('RunErrors')
  const key = ['settings:cloud', userKey] as const
  const { data, error, mutate } = useSWR(key, () => fetchSettingsData<CloudConnectionView>('/api/cloud/status'), settingsReadOptions)
  useLiveKey('model_settings', workspaceId, [unstable_serialize(key)], workspaceId)
  const [pending, setPending] = useState(false), [failure, setFailure] = useState<string | null>(null)
  const [serverName, setServerName] = useState('Mikka'), [serverKey, setServerKey] = useState('')
  const [scopes, setScopes] = useState<CloudScope[]>([...AVAILABLE_CLOUD_SCOPES])
  const [confirming, setConfirming] = useState<'server' | 'key' | null>(null)

  const errorCopy = (code: unknown) => errors(`${cloudErrorCode(code) ?? 'cloud_unavailable'}.default`)
  async function write(path: 'connect' | 'disconnect', body: Record<string, unknown>) {
    if (pending) return
    setPending(true); setFailure(null)
    try {
      const response = await fetch(withBasePath(`/api/cloud/${path}`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const value = await response.json()
      if (!response.ok) { setFailure(errorCopy(value.error)); return }
      if (typeof value.url === 'string') {
        // The authorization URL is supplied only by the configured cloud client.
        const url = new URL(value.url), service = new URL(data!.serviceUrl)
        if (url.origin !== service.origin || url.pathname !== `${service.pathname}/oauth/authorize`) { setFailure(errorCopy('cloud_unavailable')); return }
        window.location.assign(url.href)
        return
      }
      setServerKey('')
      await mutate(value as CloudConnectionView, { revalidate: false })
    } catch { setFailure(errorCopy('cloud_unavailable')) }
    finally { setPending(false) }
  }

  if (error) return <SettingsSection id="cloud-heading" title={t('title')}><FieldError className="px-5 py-3">{errorCopy(error instanceof SettingsReadError ? error.message : null)}</FieldError></SettingsSection>
  if (!data) return <SettingsLoading label={t('loading')} />
  if (!personal && !data.administrator) return null
  const connected = personal ? data.personal.connected : data.registered
  return <SettingsSection id={personal ? 'personal-cloud-heading' : 'cloud-heading'} title={t('title')}>
    <SettingRow title={t(personal ? 'account' : 'server')}>
      <span>{t(connected ? 'connected' : data.personal.revoked && personal ? 'revoked' : 'disconnected')}</span>
    </SettingRow>
    {personal ? <>
      {connected && <SettingRow title={t('billing')}><span>{t('personalBilling')}</span></SettingRow>}
      {!connected && data.team.connected && <SettingRow title={t('billing')}><span>{t('teamBilling')}</span></SettingRow>}
      {!connected && data.registered && <SettingRow title={t('services')}><div className="flex flex-wrap gap-4">
        {AVAILABLE_CLOUD_SCOPES.map(scope => <Label key={scope} className="flex items-center gap-2">
          <Checkbox checked={scopes.includes(scope)} disabled={pending} onCheckedChange={checked => setScopes(current => checked ? [...current, scope] : current.filter(item => item !== scope))} />
          {t(`scopes.${scope}`)}
        </Label>)}
      </div></SettingRow>}
      <SettingRow title={t('account')}>
        {connected ? <Button variant="outline" size="sm" disabled={pending} onClick={() => void write('disconnect', { action: 'personal' })}>{t('disconnect')}</Button>
          : <Button size="sm" disabled={pending || !data.registered || !scopes.length} onClick={() => void write('connect', { action: 'bind', scopes })}>{t('connectAccount')}</Button>}
      </SettingRow>
      {!data.registered && <SettingRow title={t('server')}><span>{t('administratorRequired')}</span></SettingRow>}
    </> : <>
      {!data.registered ? <>
        <SettingRow title={t('name')}><Input aria-label={t('name')} value={serverName} maxLength={100} onChange={event => setServerName(event.target.value)} disabled={pending} /></SettingRow>
        <SettingRow title={t('server')}><Button size="sm" disabled={pending || !serverName.trim()} onClick={() => void write('connect', { action: 'register', name: serverName })}>{t('connect')}</Button></SettingRow>
      </> : <>
        <SettingRow title={t('pushContent')}><NativeSelect aria-label={t('pushContent')} value={data.pushContent} disabled={pending} onChange={event => void write('connect', { action: 'push-content', value: event.target.value })}>
          <NativeSelectOption value="full">{t('pushFull')}</NativeSelectOption><NativeSelectOption value="reminder">{t('pushReminder')}</NativeSelectOption>
        </NativeSelect></SettingRow>
        <SettingRow title={t('serverKey')}>
          <div className="flex w-full items-center gap-2">
            <Input type="password" autoComplete="off" aria-label={t('serverKey')} value={serverKey} onChange={event => setServerKey(event.target.value)} disabled={pending} />
            <Button variant="secondary" size="sm" disabled={pending || !serverKey.trim()} onClick={() => void write('connect', { action: 'key', key: serverKey.trim() })}>{t('save')}</Button>
          </div>
        </SettingRow>
        <SettingRow title={t('team')}><span>{t(data.team.connected ? 'connected' : 'disconnected')}</span>
          {data.team.connected && <Button variant="outline" size="sm" disabled={pending} onClick={() => setConfirming('key')}>{t('revokeKey')}</Button>}
        </SettingRow>
        <SettingRow title={t('connectedServers')}><Button variant="outline" size="sm" nativeButton={false} render={<a href={`${data.serviceUrl}/manage?serverId=${encodeURIComponent(data.serverId!)}`} target="_blank" rel="noreferrer" />}>{t('manage')}</Button></SettingRow>
        <SettingRow title={t('server')}><Button variant="destructive" size="sm" disabled={pending} onClick={() => setConfirming('server')}>{t('disconnect')}</Button></SettingRow>
      </>}
    </>}
    {failure && <FieldError className="px-5 py-3">{failure}</FieldError>}
    <Dialog open={confirming !== null} onOpenChange={open => { if (!open) setConfirming(null) }}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader><DialogTitle>{t(confirming === 'key' ? 'confirmRevokeKey' : 'confirmDisconnectServer')}</DialogTitle></DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirming(null)}>{t('cancel')}</Button>
          <Button variant="destructive" disabled={pending} onClick={() => { const action = confirming; setConfirming(null); if (action) void write('disconnect', { action }) }}>{t(confirming === 'key' ? 'revokeKey' : 'disconnect')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </SettingsSection>
}

/** Models and subscriptions lists this option only for the effective models
 * binding. It shares the existing status key and live invalidation. */
export function CloudModelSettings({ userKey, workspaceId }: { userKey: string; workspaceId: string }) {
  const t = useTranslations('Settings.cloud'), errors = useTranslations('RunErrors')
  const key = ['settings:cloud', userKey] as const
  const { data, error } = useSWR(key, () => fetchSettingsData<CloudConnectionView>('/api/cloud/status'), settingsReadOptions)
  useLiveKey('model_settings', workspaceId, [unstable_serialize(key)], workspaceId)
  if (error) return <FieldError>{errors('cloud_unavailable.default')}</FieldError>
  if (!data) return <SettingsLoading label={t('loading')} rows={1} />
  const binding = data.personal.connected || data.personal.revoked ? data.personal : data.team
  if (!data.registered || !binding.connected || !binding.scopes.includes('models')) return null
  return <SettingsSection id="cloud-models-heading" title={t('scopes.models')}>
    <SettingRow title={t('defaultModel')} icon={<span className="flex size-4 shrink-0 items-center justify-center"><MikkaMarkSmall /></span>}>
      <Button size="sm" variant="outline" nativeButton={false} render={<a href={withBasePath('/api/cloud/models/billing?redirect=1')} target="_blank" rel="noreferrer" />}>{t('topUp')}</Button>
    </SettingRow>
  </SettingsSection>
}
