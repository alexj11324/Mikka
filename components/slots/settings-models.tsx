'use client'

import { useTranslations } from 'next-intl'
import { SubscriptionSettings } from '@/components/settings/subscription-settings'
import { SubscriptionShareSettings } from '@/components/settings/subscription-share-settings'
import { ApiKeyFallbackSetting, useApiKeyList } from '@/components/settings/api-key-settings'
import { ModelOrderSettings } from '@/components/settings/model-order-settings'
import { FactoryProfilesSettings } from '@/components/settings/factory-profiles-settings'
import type { SettingsModelsProps } from '@/components/slots/settings-models-contract'

/**
 * 模型与订阅 (decision 2026-11-02-1400): the subscriptions and the API keys
 * (connect, status, 重新获取模型) and API-key fallback belong to the account.
 * The person's thread defaults, run location and sharing choices below are
 * scoped to the workspace open here. 付款 is under 计费 only.
 */
export function ApiAndSubscriptions({ workspaceId, workspaceName, team }: SettingsModelsProps) {
  const scopeT = useTranslations('Settings.modelScope')
  const apiKeys = useApiKeyList(workspaceId)
  return <>
    <section aria-labelledby="account-models-scope" className="flex flex-col gap-6">
      <h2 id="account-models-scope" className="pl-1 text-sm font-medium text-muted-foreground">{scopeT('account')}</h2>
      <SubscriptionSettings workspaceId={workspaceId} />
      {apiKeys.section}
      <ApiKeyFallbackSetting workspaceId={workspaceId} />
    </section>
    {apiKeys.dialogs}
    <section aria-labelledby="workspace-models-scope" className="flex flex-col gap-6">
      <h2 id="workspace-models-scope" className="pl-1 text-sm font-medium text-muted-foreground">{scopeT('workspace', { name: workspaceName ?? scopeT('currentWorkspace') })}</h2>
      <ModelOrderSettings key={`order-${workspaceId}`} workspaceId={workspaceId} />
      <FactoryProfilesSettings key={`profiles-${workspaceId}`} workspaceId={workspaceId} />
      {team && <SubscriptionShareSettings key={`share-${workspaceId}`} workspaceId={workspaceId} workspaceName={workspaceName} />}
    </section>
  </>
}
