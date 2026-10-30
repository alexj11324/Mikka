'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { MikkaMarkSmall } from '@/components/brand/mikka-mark'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Link } from '@/i18n/navigation'
import type { HostedRefusal } from '@/lib/billing/verification-client'
import { settingsHref } from '@/lib/settings-sections'
import { VerifyCardDialog } from './verify-card-dialog'

/**
 * A hosted-model (Mikka 默认) call was refused (#523, #525, #526). Shown above
 * the composer in place of the generic failed-turn alert. Unverified
 * workspaces verify a card here; the others switch to their own model.
 */
export function HostedRefusalNotice({ code, onVerified }: { code: HostedRefusal; onVerified?: () => void }) {
  const t = useTranslations('Billing.refusal')
  const tVerify = useTranslations('Billing.verify')
  const [verifying, setVerifying] = useState(false)
  // Verified: the refused turn stays failed, the next message goes through.
  const [verified, setVerified] = useState(false)
  if (verified) return null
  const title = code === 'usage_in_progress' || code === 'usage_cost_unavailable' ? t('unavailable') : t(code)
  return <>
    <Alert data-hosted-refusal={code} className="flex items-center gap-2 py-1.5 pr-1.5">
      <MikkaMarkSmall />
      <AlertTitle className="min-w-0 flex-1">{title}</AlertTitle>
      {code === 'verification_required'
        ? <Button size="sm" onClick={() => setVerifying(true)}>{tVerify('title')}</Button>
        : code === 'free_allowance_used' || code === 'points_exhausted' || code === 'platform_paused'
          ? <Button size="sm" variant="secondary" nativeButton={false} role="link" render={<Link href={settingsHref('models')} />}>{t('switchModel')}</Button>
          : null}
    </Alert>
    {verifying && <VerifyCardDialog onClose={usage => {
      setVerifying(false)
      if (!usage) return
      toast.success(tVerify('verified'))
      setVerified(true)
      onVerified?.()
    }} />}
  </>
}
