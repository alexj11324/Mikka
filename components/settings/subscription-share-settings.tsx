'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { getSubscriptionShare, updateSubscriptionShare } from '@/app/actions/personal-policy'
import { SettingRow, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { Switch } from '@/components/ui/switch'
import { FieldError } from '@/components/ui/field'
import { useActionError } from '@/lib/use-action-error'

/**
 * 在这里使用我的订阅: a member shares their own subscriptions into this team
 * workspace, for their own bots only. A personal workspace always uses them,
 * so it shows nothing here (decision 2026-10-31-2225).
 */
export function SubscriptionShareSettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.subscriptionShare')
  const commonT = useTranslations('Common')
  const actionError = useActionError()
  const share = useSWR(['settings:subscription-share', workspaceId], () => getSubscriptionShare(workspaceId))
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState<{ shared: boolean; message: string } | null>(null)
  const data = share.data && !share.data.error ? share.data : null

  async function change(shared: boolean) {
    setPending(true)
    setFailed(null)
    try {
      const result = await updateSubscriptionShare(shared, workspaceId)
      if (result.error) { setFailed({ shared, message: actionError(result.error) }); return }
      await share.mutate(result, { revalidate: false })
    } catch {
      setFailed({ shared, message: actionError() })
    } finally {
      setPending(false)
    }
  }

  if (share.data?.error) return <FieldError>{actionError(share.data.error)}</FieldError>
  if (!data || data.personal) return null
  return <>
    <SettingsSection id="subscription-share-heading" title={t('heading')}>
      <SettingRow title={t('share')}>
        {data.allowed
          ? <Switch aria-label={t('share')} checked={data.shared} disabled={pending} onCheckedChange={shared => void change(shared)} />
          : <span className="text-sm text-muted-foreground">{t('blocked')}</span>}
      </SettingRow>
    </SettingsSection>
    {failed && <SettingsSaveError message={failed.message} retryLabel={commonT('retry')} onRetry={() => void change(failed.shared)} />}
  </>
}
