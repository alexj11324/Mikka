'use client'

import { useState, useSyncExternalStore } from 'react'
import { useTranslations } from 'next-intl'
import { ServerChooser } from '@/components/desktop/desktop-server'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { serverDocumentKind } from '@/lib/server-pages'
import { addServer, currentWebServers, disconnectServer, signInToServer, subscribeWebServers, switchServer, webServerSnapshot } from '@/lib/web-connection/browser'
import { WebConnectionError } from '@/lib/web-connection/client'

/** The official browser's login, account menu and settings share the same
 * chooser. The self-host's own sign-in and consent pages stay on that host. */
export function WebServerControl({ afterSelection, settings = false }: { afterSelection?: (cloud: boolean) => void; settings?: boolean }) {
  const t = useTranslations('DesktopServer')
  const errors = useTranslations('RunErrors')
  const auth = useTranslations('Auth')
  const { account, expiredServer } = useSyncExternalStore(subscribeWebServers, webServerSnapshot, webServerSnapshot)
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState('')
  const directory = currentWebServers()
  if (!directory || serverDocumentKind()) return null
  const servers = directory.getServers()
  const current = servers.find(server => server.url === (account?.server ?? expiredServer))
  const saved = servers.flatMap(server => server.accounts.map(user => ({
    id: JSON.stringify([server.url, user.user.id]),
    label: `${user.user.email} · ${server.url}`,
    server: server.url,
    userId: user.user.id,
  })))
  const activeChoice = saved.find(item => item.server === account?.server && item.userId === account?.user.id)?.id
  const errorText = (error: unknown) => error instanceof WebConnectionError && errors.has(`${error.code}.default` as never)
    ? errors(`${error.code}.default` as never) : t('errors.failed')
  async function select(url: string | null, choice?: string) {
    const entry = saved.find(item => item.id === choice)
    if (entry) await switchServer(entry.server, entry.userId)
    else if (url) await signInToServer(url)
    else await switchServer(null)
    setOpen(false)
    afterSelection?.(!entry && !url)
  }
  async function reconnect() {
    if (!expiredServer || pending) return
    setPending(true); setFailure('')
    try { await select(expiredServer) }
    catch (error) { setFailure(errorText(error)) }
    finally { setPending(false) }
  }
  async function disconnect() {
    if (!current || pending) return
    setPending(true); setFailure('')
    try { await disconnectServer(current.url) }
    catch (error) { setFailure(errorText(error)) }
    finally { setPending(false); setConfirm(false) }
  }
  return <div role="group" aria-label={t('server')} className="flex flex-wrap items-center gap-2">
    <span className="text-sm">{t('server')} · {current?.name ?? t('cloud')}</span>
    {expiredServer && <>
      <span>{auth('sessionExpired')}</span>
      <Button type="button" size="sm" disabled={pending} onClick={() => void reconnect()}>{auth('signIn')}</Button>
    </>}
    <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>{t('change')}</Button>
    {settings && current && <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => setConfirm(true)}>{t('disconnect')}</Button>}
    {failure && <FieldError>{failure}</FieldError>}
    {open && <ServerChooser open onOpenChange={setOpen} current={null} activeChoice={activeChoice}
      saved={saved} select={select} errorText={errorText} probeServer={async input => {
        const probe = await addServer(input)
        if (probe.status === 'web_disabled') throw new WebConnectionError('web_connection_disabled')
        return probe.status === 'ok' ? { status: 'ok', server: { ...probe.server, cloud: false, accounts: 0 } } : probe
      }} />}
    {confirm && <AlertDialog open onOpenChange={value => { if (!pending) setConfirm(value) }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>{t('disconnectTitle', { name: current?.name ?? '' })}</AlertDialogTitle></AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t('cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={pending} onClick={event => { event.preventDefault(); void disconnect() }}>{t('disconnect')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>}
  </div>
}
