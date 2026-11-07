'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { ServerIcon } from 'lucide-react'
import type { BundledServer } from '@mikka/protocol/bridge'
import { withBasePath } from '@/lib/base-path'
import { clearPersistentReadCaches } from '@/lib/swr/persistent-cache'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { ServerDialog, desktopServers, useDesktopServers, useServerLabel } from '@/components/desktop/desktop-server'

/**
 * Settings › 账户 › 服务器, desktop only (#1557): the server this window talks
 * to, switching to another one (sign in there as another account), and
 * disconnecting a server, which signs out its accounts. Absent on the web.
 */
export function DesktopServerSettings() {
  const t = useTranslations('DesktopServer')
  const label = useServerLabel()
  const { state, setState } = useDesktopServers()
  const [choosing, setChoosing] = useState(false)
  const [leaving, setLeaving] = useState<BundledServer | null>(null)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  if (!state) return null
  const current = state.current
  const rows = [current, ...state.servers.filter(server => server.url !== current.url && server.accounts > 0)]

  async function disconnect(server: BundledServer) {
    const api = desktopServers()
    if (!api) return
    setPending(true); setFailed(false)
    try {
      const next = await api.disconnect(server.url)
      setLeaving(null)
      if (server.url === current.url) { await clearPersistentReadCaches(); return }
      setState(next)
    } catch { setFailed(true) }
    finally { setPending(false) }
  }

  return <div data-desktop-only className="contents">
    <SettingsSection id="desktop-server-heading" title={t('server')}>
      {rows.map(server => <SettingRow key={server.url} icon={<ServerIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />} title={label(server)} description={server.cloud ? undefined : new URL(server.url).host}>
        <div className="flex items-center gap-2">
          {server.url === current.url && <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => setChoosing(true)}>{t('switch')}</Button>}
          <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => { setFailed(false); setLeaving(server) }}>{t('disconnect')}</Button>
        </div>
      </SettingRow>)}
      {failed && <FieldError className="px-5 pb-3">{t('errors.failed')}</FieldError>}
    </SettingsSection>
    <ServerDialog key={String(choosing)} open={choosing} onOpenChange={setChoosing} current={current} onSelected={next => {
      setChoosing(false); setState(next)
      // Another server means another account: sign in there, keeping this one.
      if (next.target.url !== current.url) window.location.assign(withBasePath('/sign-in?addAccount=1'))
    }} />
    <AlertDialog open={leaving !== null} onOpenChange={open => { if (!open && !pending) setLeaving(null) }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>{t('disconnectTitle', { name: leaving ? label(leaving) : '' })}</AlertDialogTitle></AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t('cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={pending} onClick={() => { if (leaving) void disconnect(leaving) }}>{pending ? t('disconnecting') : t('disconnect')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
}
