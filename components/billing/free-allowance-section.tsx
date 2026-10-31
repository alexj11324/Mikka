'use client'

import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { ArrowUpRight, LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'
import { MikkaMarkSmall } from '@/components/brand/mikka-mark'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { Button } from '@/components/ui/button'
import { cardVerificationStatus, pollUntil, startCardVerification, type CardVerificationStatus } from '@/lib/billing/verification-client'
import { useActionError } from '@/lib/use-action-error'

export function cardVerificationKey(workspaceId: string) {
  return ['card-verification', workspaceId] as const
}

/** Drops Checkout's return parameters so a reload does not replay the return. */
function takeReturn(name: string): string | null {
  const url = new URL(window.location.href)
  const value = url.searchParams.get(name)
  if (value === null) return null
  url.searchParams.delete(name)
  url.searchParams.delete('session_id')
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  return value
}

/**
 * 计费 › 免费额度 (Figma BIL-1 `708:26856`, BIL-3c `708:28397`, BIL-5 `708:28912`).
 * 验证 goes to Stripe Checkout in setup mode (#558); nothing of ours collects the
 * card. On `?verify=success` the row shows 正在确认… while the webhook lands.
 * Verified (BIL-3 `708:27372`): the section is gone; the $1 is part of 余额.
 */
export function FreeAllowanceSection({ workspaceId, onVerified }: { workspaceId: string; onVerified?: () => void }) {
  const t = useTranslations('Billing.allowance')
  const actionError = useActionError()
  const status = useSWR(cardVerificationKey(workspaceId), () => cardVerificationStatus(workspaceId))
  const { mutate } = status
  const [confirming, setConfirming] = useState(false)
  const [redirecting, setRedirecting] = useState(false)

  useEffect(() => {
    if (takeReturn('verify') !== 'success') return
    setConfirming(true)
    void pollUntil(() => cardVerificationStatus(workspaceId), read => !read.error && read.status === 'verified').then(read => {
      setConfirming(false)
      void mutate(read, { revalidate: false })
      if (read.error || read.status !== 'verified') return
      toast.success(read.allowance === 'claimed_elsewhere' ? t('claimedElsewhere') : t('verified'))
      onVerified?.()
    })
  }, [workspaceId, mutate, onVerified, t])

  async function verify() {
    setRedirecting(true)
    try {
      const result = await startCardVerification(workspaceId)
      if (result.error) { setRedirecting(false); toast.error(result.error === 'billingNotConfigured' ? t('unavailable') : actionError(result.error)); return }
      window.location.assign(result.url)
    } catch {
      setRedirecting(false)
      toast.error(actionError('billingProviderFailed'))
    }
  }

  const data: CardVerificationStatus | null = status.data && !status.data.error ? status.data : null
  if (!data || (data.status === 'verified' && !confirming)) return null
  const pending = confirming || data.status === 'pending'
  return <SettingsSection id="billing-free-allowance" title={t('section')}>
    <SettingRow title={t('title')} description={t.rich('description', { mark: () => <MikkaMarkSmall />, model: chunks => <span className="inline-flex items-center gap-1">{chunks}</span> })}>
      {pending
        ? <span role="status" className="flex items-center gap-1.5 text-muted-foreground"><LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />{t('pending')}</span>
        : data.status === 'unavailable'
          // BIL-5 also draws a disabled 验证; a control that does nothing fails interaction/no-dead-control, so only the state shows.
          ? <span role="status" className="text-muted-foreground">{t('unavailable')}</span>
          : <Button type="button" size="sm" disabled={redirecting} onClick={() => { void verify() }}>{t('verify')}<ArrowUpRight data-icon="inline-end" /></Button>}
    </SettingRow>
  </SettingsSection>
}
