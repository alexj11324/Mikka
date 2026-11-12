'use client'

import { useState } from 'react'
import { Loader2, Users } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { acceptWorkspaceInvitation } from '@/app/actions/workspace'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { Link } from '@/i18n/navigation'
import { endSession } from '@/lib/auth-client'
import { useActionError } from '@/lib/use-action-error'
import { withBasePath } from '@/lib/base-path'
import { serverDocumentKind } from '@/lib/server-pages'
import { organizationApi, useOrganizationErrorText } from '@/hooks/settings/use-organization'

function InvitationHomeLink({ serverOnly, primary = false }: { serverOnly: boolean; primary?: boolean }) {
  const t = useTranslations('Invite')
  return <Link href="/" className={primary ? buttonVariants({ className: 'w-full' }) : 'text-sm text-muted-foreground underline underline-offset-4'}>
    {t(serverOnly ? 'viewServerAndApps' : 'backToWorkspace')}
  </Link>
}

export function InvitationCard({ token, email }: { token: string; email: string | null }) {
  const t = useTranslations('Invite')
  const translateError = useActionError()
  const serverOnly = serverDocumentKind() === 'authentication'
  const [joined, setJoined] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const next = `/invite/${token}`
  async function accept() {
    if (pending) return
    setPending(true); setError('')
    try {
      const result = await acceptWorkspaceInvitation(token)
      if (!result.ok) { setError(translateError(result.error)); return }
      if (serverOnly) setJoined(true)
      else window.location.assign(withBasePath(`/settings/members?workspace=${result.data.workspaceId}`))
    } catch { setError(t('acceptFailed')) }
    finally { setPending(false) }
  }
  async function switchAccount() {
    setPending(true)
    try { await endSession(); window.location.assign(withBasePath(`/sign-in?next=${encodeURIComponent(next)}`)) }
    catch { setError(t('signOutFailed')); setPending(false) }
  }
  return <Card className="w-full max-w-md">
    <CardHeader><Users className="mb-2" /><CardTitle>{t('joinTitle')}</CardTitle></CardHeader>
    <CardContent className="flex flex-col gap-4">
      {!token ? <Alert variant="destructive"><AlertDescription>{t('invalidToken')}</AlertDescription></Alert>
        : email && !joined ? <p className="break-all text-sm text-muted-foreground">{t('signedInAs', { email })}</p> : null}
      {joined ? <p role="status">{t('joined')}</p> : null}
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    </CardContent>
    <CardFooter className="flex flex-col gap-3">
      {!joined && token && (email ? <>
        <Button className="w-full" disabled={pending} onClick={() => void accept()}>{pending && <Loader2 className="animate-spin" data-icon="inline-start" />}{t('accept')}</Button>
        <Button variant="ghost" disabled={pending} onClick={() => void switchAccount()}>{t('switchAccount')}</Button>
      </> : <>
        <Link href={`/sign-in?next=${encodeURIComponent(next)}`} className={buttonVariants({ className: 'w-full' })}>{t('signInToAccept')}</Link>
        <Link href={`/sign-up?next=${encodeURIComponent(next)}`} className={buttonVariants({ variant: 'outline', className: 'w-full' })}>{t('createAccount')}</Link>
      </>)}
      <InvitationHomeLink serverOnly={serverOnly} primary={joined} />
    </CardFooter>
  </Card>
}


/** Same invitation card primitives; Organization membership never grants a Workspace. */
export function OrganizationInvitationCard({ token, email }: { token: string; email: string | null }) {
  const t = useTranslations('Organization.invitations')
  const invite = useTranslations('Invite')
  const serverOnly = serverDocumentKind() === 'authentication'
  const errorText = useOrganizationErrorText()
  const [pending, setPending] = useState(false)
  const [joined, setJoined] = useState(false)
  const [error, setError] = useState('')
  const next = `/organization-invite/${token}`
  async function accept() {
    if (pending || !token) return
    setPending(true); setError('')
    try { await organizationApi.acceptInvitation(token); setJoined(true) }
    catch (failure) { setError(errorText(failure)) }
    finally { setPending(false) }
  }
  async function switchAccount() {
    setPending(true)
    try { await endSession(); window.location.assign(withBasePath(`/sign-in?next=${encodeURIComponent(next)}`)) }
    catch { setError(invite('signOutFailed')); setPending(false) }
  }
  return <Card className="w-full max-w-md">
    <CardHeader><Users className="mb-2" /><CardTitle>{t('joinTitle')}</CardTitle></CardHeader>
    <CardContent className="flex flex-col gap-4">
      {!token ? <Alert variant="destructive"><AlertDescription>{t('invalidToken')}</AlertDescription></Alert> : null}
      {email && !joined ? <p className="break-all text-sm text-muted-foreground">{invite('signedInAs', { email })}</p> : null}
      {joined ? <p role="status">{t('joined')}</p> : null}
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
    </CardContent>
    <CardFooter className="flex flex-col gap-3">
      {joined && !serverOnly ? <Link href="/settings?section=organization" className={buttonVariants({ className: 'w-full' })}>{t('openOrganization')}</Link>
        : !joined && token && (email ? <>
          <Button className="w-full" disabled={pending} onClick={() => void accept()}>
            {pending && <Loader2 className="animate-spin" data-icon="inline-start" />}{t('accept')}
          </Button>
          <Button variant="ghost" disabled={pending} onClick={() => void switchAccount()}>{invite('switchAccount')}</Button>
        </> : <>
          <Link href={`/sign-in?next=${encodeURIComponent(next)}`} className={buttonVariants({ className: 'w-full' })}>{invite('signInToAccept')}</Link>
          <Link href={`/sign-up?next=${encodeURIComponent(next)}`} className={buttonVariants({ variant: 'outline', className: 'w-full' })}>{invite('createAccount')}</Link>
        </>)}
      <InvitationHomeLink serverOnly={serverOnly} primary={serverOnly && joined} />
    </CardFooter>
  </Card>
}
