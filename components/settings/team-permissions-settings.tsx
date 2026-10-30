'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { getAppPolicy, updateAppPolicy } from '@/app/actions/app-policy'
import { ComputerPolicySettings } from '@/components/settings/computer-policy-settings'
import { SettingRow, SettingsLoading, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { APP_ACCESS, type AppAccess, type PolicyApp } from '@/lib/app-policy/apps'
import { useActionError } from '@/lib/use-action-error'

/** N4 团队权限: the existing 电脑操作 row, then which connected apps the workspace's bots may use. */
export function TeamPermissionsSettings({ workspaceId }: { workspaceId: string }) {
  return <>
    <ComputerPolicySettings workspaceId={workspaceId} />
    <AppPolicySettings workspaceId={workspaceId} />
  </>
}

function AppPolicySettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.appPolicy')
  const commonT = useTranslations('Common')
  const actionError = useActionError()
  const policy = useSWR(['settings:app-policy', workspaceId], () => getAppPolicy(workspaceId))
  const [pending, setPending] = useState<PolicyApp | null>(null)
  const [failed, setFailed] = useState<{ app: PolicyApp; access: AppAccess; message: string } | null>(null)
  const data = policy.data && !policy.data.error ? policy.data : null
  const items = APP_ACCESS.map(value => ({ value, label: t(`access.${value}`) }))

  async function change(app: PolicyApp, access: AppAccess) {
    setPending(app)
    setFailed(null)
    try {
      const result = await updateAppPolicy({ app, access }, workspaceId)
      // S-O: the select keeps the saved value; 重试 sends the same change.
      if (result.error) { setFailed({ app, access, message: actionError(result.error) }); return }
      await policy.mutate(result, { revalidate: false })
    } catch {
      setFailed({ app, access, message: actionError() })
    } finally {
      setPending(null)
    }
  }

  if (!policy.data && !policy.error) return <SettingsLoading label={t('loading')} rows={4} />
  if (!data) return <p role="alert" className="text-sm text-destructive">{actionError(policy.data?.error)}</p>
  return <>
    <SettingsSection id="app-policy-heading" title={t('heading')}>
      {data.apps.map(({ app, access }) => <SettingRow key={app} title={t(`apps.${app}`)}>
        {data.canEdit
          ? <Select value={access} items={items} disabled={pending !== null} onValueChange={value => { if ((value === 'allow' || value === 'deny') && value !== access) void change(app, value) }}>
            <SelectTrigger size="sm" aria-label={t(`apps.${app}`)}><SelectValue /></SelectTrigger>
            <SelectContent align="end"><SelectGroup>{items.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
          </Select>
          : <span>{t(`access.${access}`)}</span>}
      </SettingRow>)}
    </SettingsSection>
    {failed && <SettingsSaveError message={failed.message} retryLabel={commonT('retry')} onRetry={() => void change(failed.app, failed.access)} />}
  </>
}
