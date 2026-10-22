'use client'

import { useState } from 'react'
import { Loader2, Users } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { acceptWorkspaceInvitation } from '@/app/actions/workspace'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { Link } from '@/i18n/navigation'
import { authClient } from '@/lib/auth-client'
import { withBasePath } from '@/lib/base-path'

export function InvitationCard({ token, email }: { token: string; email: string | null }) {
  const t = useTranslations('Invite')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const next = `/invite/${token}`
  async function accept() {
    if (pending) return
    setPending(true); setError('')
    try {
      const result = await acceptWorkspaceInvitation(token)
      if (!result.ok) { setError(result.error); return }
      window.location.assign(withBasePath(`/settings/members?workspace=${result.data.workspaceId}`))
    } catch { setError(t('acceptFailed')) }
    finally { setPending(false) }
  }
  async function switchAccount() {
    setPending(true)
    try { await authClient.signOut(); window.location.assign(withBasePath(`/sign-in?next=${encodeURIComponent(next)}`)) }
    catch { setError(t('signOutFailed')); setPending(false) }
  }
  return <Card className="w-full max-w-md"><CardHeader><Users className="mb-2" /><CardTitle>{t('joinTitle')}</CardTitle><CardDescription>{t('joinDescription')}</CardDescription></CardHeader><CardContent className="flex flex-col gap-4">{!token ? <Alert variant="destructive"><AlertDescription>{t('invalidToken')}</AlertDescription></Alert> : email ? <p className="break-all text-sm text-muted-foreground">{t('signedInAs', { email })}</p> : <p className="text-sm text-muted-foreground">{t('validity')}</p>}{error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}</CardContent><CardFooter className="flex flex-col gap-3">{token && (email ? <><Button className="w-full" disabled={pending} onClick={() => void accept()}>{pending && <Loader2 className="animate-spin" data-icon="inline-start" />}{t('accept')}</Button><Button variant="ghost" disabled={pending} onClick={() => void switchAccount()}>{t('switchAccount')}</Button></> : <><Link href={`/sign-in?next=${encodeURIComponent(next)}`} className={buttonVariants({ className: 'w-full' })}>{t('signInToAccept')}</Link><Link href={`/sign-up?next=${encodeURIComponent(next)}`} className={buttonVariants({ variant: 'outline', className: 'w-full' })}>{t('createAccount')}</Link></>)}<Link href="/" className="text-sm text-muted-foreground underline underline-offset-4">{t('backToWorkspace')}</Link></CardFooter></Card>
}
