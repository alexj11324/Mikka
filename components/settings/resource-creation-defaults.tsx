'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useSWRConfig } from 'swr'
import { saveOrganizationCreationDefaults } from '@/app/actions/resource-access'
import { useResourceCreation } from '@/hooks/use-resource-creation'
import { usePreferences } from './use-preferences'
import { useActionError } from '@/lib/use-action-error'
import { Switch } from '@/components/ui/switch'
import { SettingRow, SettingsLoading, SettingsSaveError, SettingsSection } from './primitives'

export function ResourceCreationDefaultsSettings({ workspaceId }: { workspaceId?: string }) {
  const t = useTranslations('ResourceAccess'), actionError = useActionError()
  const preferences = usePreferences(), defaults = useResourceCreation(workspaceId), { mutate } = useSWRConfig()
  const [pending, setPending] = useState(false), [failure, setFailure] = useState<string | null>(null)
  const writing = useRef(false), retry = useRef<(() => Promise<void>) | null>(null)
  const organization = defaults.data?.organization
  const refreshDefaults = () => mutate(key => Array.isArray(key) && key[0] === 'resource-creation-defaults')
  async function save(value: boolean, scope: 'personal' | 'organization') {
    if (writing.current) return
    writing.current = true; setPending(true); setFailure(null)
    retry.current = () => save(value, scope)
    try {
      if (scope === 'personal') {
        if (!await preferences.save({ privateByDefault: value })) { setFailure(t('saveFailed')); return }
      } else {
        if (!organization || !defaults.data) return
        const result = await saveOrganizationCreationDefaults(defaults.data.workspaceId, { privateByDefault: value, expectedRevision: organization.revision })
        if ('error' in result) { setFailure(actionError(result.error)); await defaults.mutate(); return }
      }
      await refreshDefaults(); retry.current = null
    } catch { setFailure(t('saveFailed')) }
    finally { writing.current = false; setPending(false) }
  }
  const reload = () => { void preferences.mutate(); void defaults.mutate() }
  if (preferences.error || defaults.error) return <SettingsSaveError message={t('loadFailed')} retryLabel={t('retry')} onRetry={reload} />
  if (!preferences.data || !defaults.data) return <SettingsLoading label={t('loading')} rows={2} />
  return <SettingsSection id="creation-privacy" title={t('defaultsTitle')} description={t('defaultsDescription')}>
    <SettingRow title={t('personalDefault')} description={t('personalDefaultDescription')}>
      <Switch aria-label={t('personalDefault')} checked={preferences.data.privateByDefault} disabled={pending} onCheckedChange={value => { void save(value, 'personal') }} />
    </SettingRow>
    {organization && <SettingRow title={t('organizationDefault')} description={t(organization.canManage ? 'organizationDefaultDescription' : 'organizationDefaultReadOnly')}>
      <Switch aria-label={t('organizationDefault')} checked={organization.privateByDefault} disabled={pending || !organization.canManage} onCheckedChange={value => { void save(value, 'organization') }} />
    </SettingRow>}
    {failure && <SettingsSaveError message={failure} retryLabel={t('retry')} onRetry={() => { void retry.current?.() }} />}
  </SettingsSection>
}
