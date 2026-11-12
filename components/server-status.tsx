'use client'

import { useTranslations } from 'next-intl'
import { Auth } from '@/components/blocks/auth-19/components/auth'
import { AuthCard } from '@/components/blocks/auth-19/components/auth-card'
import { buttonVariants } from '@/components/ui/button'
import type { ServerInfo } from '@/lib/server-info'

/** This public document never loads a workspace, session bootstrap or polling. */
export default function ServerStatus() {
  const t = useTranslations('ServerStatus')
  const data = document.getElementById('mikka-server-info')?.textContent
  if (!data) throw new Error('SERVER_STATUS_DOCUMENT_INVALID')
  const info: ServerInfo = JSON.parse(data)
  return <Auth><AuthCard title={t('title')} description={info.name}>
    <dl className="grid gap-3 text-sm">
      <div><dt className="text-muted-foreground">{t('address')}</dt><dd className="break-all">{info.address ?? t('unavailable')}</dd></div>
      <div><dt className="text-muted-foreground">{t('version')}</dt><dd className="break-all font-mono">{info.version}</dd></div>
      {(['configuration', 'database', 'authentication'] as const).map(key =>
        <div key={key} className="flex items-center justify-between gap-3"><dt>{t(key)}</dt><dd>{t(info.status[key])}</dd></div>)}
    </dl>
    <div className="flex flex-col gap-3">
      {info.setup.signUpUrl && <a className={buttonVariants()} href={info.setup.signUpUrl}>{t('create')}</a>}
      {info.clients.web.enabled && info.clients.web.serverAddressSupported && info.clients.web.url && <a className={buttonVariants({ variant: 'outline' })} href={info.clients.web.url}>{t('web')}</a>}
      <a className={buttonVariants({ variant: 'outline' })} href={info.clients.desktop.url}>{t('desktop')}</a>
      <p className="text-sm text-muted-foreground">{t(info.clients.ios.serverReady ? 'ios' : 'iosUnavailable')}</p>
    </div>
  </AuthCard></Auth>
}
