'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useFormatter, useTranslations } from 'next-intl'
import { getPaymentDesignation, updatePaymentDesignation } from '@/app/actions/personal-policy'
import { SettingRow, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { Switch } from '@/components/ui/switch'
import { useActionError } from '@/lib/use-action-error'

/**
 * 由我的卡支付这个团队: a member pays for a team with their own verified card.
 * Stopping it, or leaving, keeps the card paying through a grace period, which
 * admins see here and on 计费 (decision 2026-10-31-2225). Nothing shows in a
 * personal workspace or to a member without a card.
 */
export function PaymentDesignationSettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.paymentDesignation')
  const commonT = useTranslations('Common')
  const format = useFormatter()
  const actionError = useActionError()
  const designation = useSWR(['settings:payment-designation', workspaceId], () => getPaymentDesignation(workspaceId))
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState<{ designated: boolean; message: string } | null>(null)
  const data = designation.data && !designation.data.error ? designation.data : null

  async function change(designated: boolean) {
    setPending(true)
    setFailed(null)
    try {
      const result = await updatePaymentDesignation(designated, workspaceId)
      if (result.error) { setFailed({ designated, message: actionError(result.error) }); return }
      await designation.mutate(result, { revalidate: false })
    } catch {
      setFailed({ designated, message: actionError() })
    } finally {
      setPending(false)
    }
  }

  if (!data || (!data.canDesignate && !data.mine && !data.payerName && !data.graceUntil)) return null
  return <>
    <SettingsSection id="payment-designation-heading" title={t('heading')}>
      {(data.canDesignate || data.mine) && <SettingRow title={t('mine')}>
        <Switch aria-label={t('mine')} checked={data.mine} disabled={pending} onCheckedChange={designated => void change(designated)} />
      </SettingRow>}
      {data.admin && data.payerName && <SettingRow title={t('payer', { name: data.payerName })}>
        <span className="text-sm text-muted-foreground">{data.graceUntil ? t('until', { date: format.dateTime(new Date(data.graceUntil), { dateStyle: 'medium' }) }) : t('active')}</span>
      </SettingRow>}
    </SettingsSection>
    {failed && <SettingsSaveError message={failed.message} retryLabel={commonT('retry')} onRetry={() => void change(failed.designated)} />}
  </>
}
