'use client'

import { useTranslations } from 'next-intl'
import { ArrowUpRight, LoaderCircle } from 'lucide-react'
import { MikkaMarkSmall } from '@/components/brand/mikka-mark'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { Button } from '@/components/ui/button'
import type { FreeAllowanceState } from '@/hooks/settings/use-billing'

export { cardVerificationKey } from '@/hooks/settings/use-billing'

/**
 * 计费 › 免费额度 (Figma BIL-1 `708:26856`, BIL-3c `708:28397`, BIL-5 `708:28912`).
 * 验证 goes to Stripe Checkout in setup mode (#558, `useFreeAllowance`); nothing of
 * ours collects the card. Back from Checkout the row shows 正在确认… while the
 * webhook lands. Verified (BIL-3 `708:27372`): the section is gone; the $1 is part of 余额.
 */
export function FreeAllowanceSection({ allowance }: { allowance: FreeAllowanceState }) {
  const t = useTranslations('Billing.allowance')
  const { confirming, redirecting, verify } = allowance
  const data = allowance.status
  if (!data || (data.status === 'verified' && !confirming)) return null
  const pending = confirming || data.status === 'pending'
  return <SettingsSection id="billing-free-allowance" title={t('section')}>
    <SettingRow title={t('title')} description={t.rich('description', { mark: () => <MikkaMarkSmall />, model: chunks => <span className="inline-flex items-center gap-1">{chunks}</span> })}>
      {pending
        ? <span role="status" className="flex items-center gap-1.5 text-muted-foreground"><LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />{t('pending')}</span>
        : data.status === 'unavailable'
          // BIL-5 also draws a disabled 验证; a control that does nothing fails interaction/no-dead-control, so only the state shows.
          ? <span role="status" className="text-muted-foreground">{t('unavailable')}</span>
          : <Button type="button" size="sm" disabled={redirecting} onClick={verify}>{t('verify')}<ArrowUpRight data-icon="inline-end" /></Button>}
    </SettingRow>
  </SettingsSection>
}
