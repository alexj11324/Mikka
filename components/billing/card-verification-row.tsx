'use client'

import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { CircleCheck } from 'lucide-react'
import { toast } from 'sonner'
import { MikkaMarkSmall } from '@/components/brand/mikka-mark'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { Button } from '@/components/ui/button'
import { getHostedUsage, waitForVerification } from '@/lib/billing/verification-client'
import { VerifyCardDialog } from './verify-card-dialog'

export function hostedUsageKey(workspaceId?: string) {
  return ['hosted-usage', workspaceId ?? null] as const
}

/**
 * 计费 › 验证银行卡 (#523). Hidden until the backend reports hosted usage for
 * this deployment. A card already used by another workspace still verifies,
 * with no allowance; the remaining amount is in 用量.
 */
export function CardVerificationRow({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Billing.verify')
  const usage = useSWR(hostedUsageKey(workspaceId), () => getHostedUsage(workspaceId))
  const [open, setOpen] = useState(false)
  const data = usage.data && !usage.data.error ? usage.data : null
  const { mutate } = usage

  // Back from a bank page that needed a redirect: wait for the webhook, then drop Stripe's parameters.
  useEffect(() => {
    const url = new URL(window.location.href)
    if (!url.searchParams.has('setup_intent')) return
    const succeeded = url.searchParams.get('redirect_status') === 'succeeded'
    for (const name of ['setup_intent', 'setup_intent_client_secret', 'redirect_status']) url.searchParams.delete(name)
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
    if (!succeeded) { toast.error(t('failed')); return }
    void waitForVerification(async () => {
      const read = await getHostedUsage(workspaceId)
      return read.error ? null : read
    }).then(verified => {
      if (verified) { toast.success(t('verified')); void mutate(verified, { revalidate: false }) }
    })
  }, [workspaceId, t, mutate])

  if (!data) return null
  return <SettingsSection id="billing-verification">
    <SettingRow icon={<MikkaMarkSmall />} title={t('model')} description={data.balance.verified ? undefined : t('allowance')}>
      {data.balance.verified
        ? <span className="flex items-center gap-1.5 text-muted-foreground"><CircleCheck aria-hidden="true" className="size-4" />{t('verifiedLabel')}</span>
        : <Button type="button" size="sm" onClick={() => setOpen(true)}>{t('title')}</Button>}
    </SettingRow>
    {open && <VerifyCardDialog workspaceId={workspaceId} onClose={verified => {
      setOpen(false)
      if (!verified) return
      toast.success(t('verified'))
      void mutate(verified, { revalidate: false })
    }} />}
  </SettingsSection>
}
