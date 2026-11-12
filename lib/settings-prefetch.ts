import type { Cache, Key, useSWRConfig } from 'swr'
import type { listEnvironments } from '@/app/actions/environments'
import type { getPasswordStatus, listSessions } from '@/app/actions/account'
import type { getPreferences } from '@/app/actions/preferences'
import type { getIssuePrefixState } from '@/app/actions/issue-prefix'
import type { listSavedLogins } from '@/app/actions/settings-activity'
import type { getWorkspaceDeletionImpact, getWorkspaceGeneral, getWorkspaceTransferTargets } from '@/app/actions/workspace-settings'
import { apiKeysKey, readApiKeys } from '@/components/settings/api-key-settings'
import { readSubscriptionUsage, readSubscriptions, subscriptionUsageKey, subscriptionsKey } from '@/components/settings/subscription-settings'
import type { getAppPolicy } from '@/app/actions/app-policy'
import type { getSharePolicy } from '@/app/actions/personal-policy'
import type { getE2BKeyCapability, listSecrets } from '@/app/actions/workspace-secrets'
import type { getUsage } from '@/app/actions/usage'
import type { getBilling } from '@/app/actions/billing'
import type { listAuditLog } from '@/app/actions/audit-log'
import { getCreditBilling, readCardVerification } from '@/lib/billing/verification-client'
import { modelOrderKey, readModelOrder } from '@/components/settings/model-order-settings'
import { creditBillingKey } from '@/components/billing/balance-section'
import { cardVerificationKey } from '@/components/billing/free-allowance-section'
import { computerPolicyKey, readComputerPolicy } from '@/hooks/settings/use-team-permissions'
import { connectedAppsKey, readConnectedApps } from '@/components/plugins/connected-apps'
import { currentMonth } from '@/lib/usage/month'
import { settingsRead } from '@/lib/settings-read'
import type { SettingsSectionId } from '@/lib/settings-sections'
import { settingsKeys } from '@/lib/swr/keys'
import { prefetchScopedRead } from '@/lib/swr/prefetch'

type Result<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>

/**
 * The first read of each section, with the same SWR keys and GET reads the
 * section uses, so the cache is filled before the section opens. Keep a key
 * here in step with its section.
 */
const READS: Partial<Record<SettingsSectionId, (workspaceId: string) => [key: Key, read: () => Promise<unknown>][]>> = {
  preferences: () => [[settingsKeys.issuePrefix(), () => settingsRead<Result<typeof getIssuePrefixState>>('issue-prefix')]],
  security: () => [[settingsKeys.password(), () => settingsRead<Result<typeof getPasswordStatus>>('password')], [settingsKeys.sessions(), () => settingsRead<Result<typeof listSessions>>('sessions')]],
  notifications: () => [[settingsKeys.preferences(), () => settingsRead<Result<typeof getPreferences>>('preferences')]],
  logins: () => [[settingsKeys.savedLogins(), () => settingsRead<Result<typeof listSavedLogins>>('saved-logins')]],
  // 连接 is also the rail's 插件 page: the Composio apps' state, a GET.
  connections: () => [[connectedAppsKey, readConnectedApps]],
  general: id => [
    [settingsKeys.workspaceGeneral(id), () => settingsRead<Result<typeof getWorkspaceGeneral>>('workspace-general', { workspace: id })],
    [settingsKeys.transferTargets(id), () => settingsRead<Result<typeof getWorkspaceTransferTargets>>('transfer-targets', { workspace: id })],
    [settingsKeys.deletionImpact(id), () => settingsRead<Result<typeof getWorkspaceDeletionImpact>>('deletion-impact', { workspace: id })],
  ],
  permissions: id => [[computerPolicyKey(id), () => readComputerPolicy(id)], [settingsKeys.sharePolicy(id), () => settingsRead<Result<typeof getSharePolicy>>('share-policy', { workspace: id })], [settingsKeys.appPolicy(id), () => settingsRead<Result<typeof getAppPolicy>>('app-policy', { workspace: id })]],
  secrets: id => [[settingsKeys.secrets(id), () => settingsRead<Result<typeof listSecrets>>('secrets', { workspace: id })], [settingsKeys.e2bKey(id), () => settingsRead<Result<typeof getE2BKeyCapability>>('e2b-key', { workspace: id })]],
  environments: id => [[settingsKeys.environments(id), () => settingsRead<Result<typeof listEnvironments>>('environments', { workspace: id })]],
  usage: id => { const month = currentMonth(); return [[settingsKeys.usage(id, month), () => settingsRead<Result<typeof getUsage>>('usage', { month, workspace: id })], [creditBillingKey(id), () => getCreditBilling(id)]] },
  billing: id => [[settingsKeys.billing(id), () => settingsRead<Result<typeof getBilling>>('billing', { workspace: id })], [creditBillingKey(id), () => getCreditBilling(id)], [cardVerificationKey(id), () => readCardVerification(id)]],
  // 模型与订阅: its GET reads. 共享订阅 is still a server action, read when the section opens.
  models: id => [[subscriptionsKey(id), () => readSubscriptions(id)], [subscriptionUsageKey(id), () => readSubscriptionUsage(id)], [apiKeysKey(id), () => readApiKeys(id)], [modelOrderKey(id), () => readModelOrder(id)], [settingsKeys.e2bKey(id), () => settingsRead<Result<typeof getE2BKeyCapability>>('e2b-key', { workspace: id })]],
  // useSWRInfinite takes a preloaded page by the page's own key: page one of 全部.
  audit: id => [[settingsKeys.audit(id, 'all', null), () => settingsRead<Result<typeof listAuditLog>>('audit', { workspace: id, filter: 'all' })]],
}

export function prefetchSettingsSection(section: SettingsSectionId, workspaceId: string | undefined, cache: Cache, mutate: ReturnType<typeof useSWRConfig>['mutate']) {
  const reads = READS[section]
  if (!reads || (!workspaceId && !['preferences', 'security', 'notifications', 'logins', 'connections'].includes(section))) return
  for (const [key, read] of reads(workspaceId ?? '')) {
    void prefetchScopedRead(cache, mutate, key, read)
  }
}

/** Once the app is idle, the 插件 list's state, so the rail's 插件 page opens on it. */
export function prefetchConnectedApps(cache: Cache, mutate: ReturnType<typeof useSWRConfig>['mutate']) {
  return whenIdle(() => prefetchSettingsSection('connections', undefined, cache, mutate))
}

function whenIdle(run: () => void) {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(run, { timeout: 2000 })
    return () => window.cancelIdleCallback(handle)
  }
  const timer = window.setTimeout(run, 200)
  return () => window.clearTimeout(timer)
}
