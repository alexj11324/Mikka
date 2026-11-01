import { preload, unstable_serialize, type Cache } from 'swr'
import type { getPasswordStatus, listSessions } from '@/app/actions/account'
import type { getPreferences } from '@/app/actions/preferences'
import type { listSavedLogins } from '@/app/actions/settings-activity'
import type { getWorkspaceDeletionImpact, getWorkspaceGeneral, getWorkspaceTransferTargets } from '@/app/actions/workspace-settings'
import { apiKeysKey, readApiKeys } from '@/components/settings/api-key-settings'
import { readSubscriptionUsage, readSubscriptions, subscriptionUsageKey, subscriptionsKey } from '@/components/settings/subscription-settings'
import type { getAppPolicy } from '@/app/actions/app-policy'
import type { getPersonalPolicy } from '@/app/actions/personal-policy'
import type { getE2BKeyCapability, listSecrets } from '@/app/actions/workspace-secrets'
import type { getUsage } from '@/app/actions/usage'
import type { getBilling } from '@/app/actions/billing'
import type { listAuditLog } from '@/app/actions/audit-log'
import { getCreditBilling, readCardVerification } from '@/lib/billing/verification-client'
import { botAgentsReads } from '@/lib/execution-settings-client'
import { creditBillingKey } from '@/components/billing/balance-section'
import { cardVerificationKey } from '@/components/billing/free-allowance-section'
import { computerPolicyKey, readComputerPolicy } from '@/components/settings/computer-policy-settings'
import { connectedAppsKey, readConnectedApps } from '@/components/plugins/connected-apps'
import { currentMonth } from '@/lib/usage/month'
import { settingsRead } from '@/lib/settings-read'
import { visibleSettingsSections, type SettingsSectionId } from '@/lib/settings-sections'

type Result<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>

/**
 * The first read of each section, with the same SWR keys and GET reads the
 * section uses, so the cache is filled before the section opens. Keep a key
 * here in step with its section.
 */
const READS: Partial<Record<SettingsSectionId, (workspaceId: string) => [key: unknown, read: () => Promise<unknown>][]>> = {
  security: () => [['account:password', () => settingsRead<Result<typeof getPasswordStatus>>('password')], ['account:sessions', () => settingsRead<Result<typeof listSessions>>('sessions')]],
  notifications: () => [['preferences', () => settingsRead<Result<typeof getPreferences>>('preferences')]],
  logins: () => [['account:saved-logins', () => settingsRead<Result<typeof listSavedLogins>>('saved-logins')]],
  // 连接 is also the rail's 插件 page: the Composio apps' state, a GET.
  connections: () => [[connectedAppsKey, readConnectedApps]],
  general: id => [
    [['workspace:general', id], () => settingsRead<Result<typeof getWorkspaceGeneral>>('workspace-general', { workspace: id })],
    [['workspace:transfer-targets', id], () => settingsRead<Result<typeof getWorkspaceTransferTargets>>('transfer-targets', { workspace: id })],
    [['workspace:deletion-impact', id], () => settingsRead<Result<typeof getWorkspaceDeletionImpact>>('deletion-impact', { workspace: id })],
  ],
  permissions: id => [[computerPolicyKey(id), () => readComputerPolicy(id)], [['settings:personal-policy', id], () => settingsRead<Result<typeof getPersonalPolicy>>('personal-policy', { workspace: id })], [['settings:app-policy', id], () => settingsRead<Result<typeof getAppPolicy>>('app-policy', { workspace: id })]],
  secrets: id => [[['settings:secrets', id], () => settingsRead<Result<typeof listSecrets>>('secrets', { workspace: id })], [['settings:e2b-key', id], () => settingsRead<Result<typeof getE2BKeyCapability>>('e2b-key', { workspace: id })]],
  usage: id => { const month = currentMonth(); return [[['settings:usage', id, month], () => settingsRead<Result<typeof getUsage>>('usage', { month, workspace: id })], [creditBillingKey(id), () => getCreditBilling(id)]] },
  billing: id => [[['settings:billing', id], () => settingsRead<Result<typeof getBilling>>('billing', { workspace: id })], [creditBillingKey(id), () => getCreditBilling(id)], [cardVerificationKey(id), () => readCardVerification(id)]],
  bots: () => botAgentsReads(),
  // API 与订阅: its GET reads. 共享订阅 and 付款 are still server actions, read when the section opens.
  models: id => [[subscriptionsKey(id), () => readSubscriptions(id)], [subscriptionUsageKey(id), () => readSubscriptionUsage(id)], [apiKeysKey(id), () => readApiKeys(id)], [['settings:e2b-key', id], () => settingsRead<Result<typeof getE2BKeyCapability>>('e2b-key', { workspace: id })]],
  // useSWRInfinite takes a preloaded page by the page's own key: page one of 全部.
  audit: id => [[['settings:audit', id, 'all', null], () => settingsRead<Result<typeof listAuditLog>>('audit', { workspace: id, filter: 'all' })]],
}

const started = new Set<string>()

export function prefetchSettingsSection(section: SettingsSectionId, workspaceId: string | undefined, cache: Cache) {
  const reads = READS[section]
  // Workspace sections need the workspace; a section is fetched once per page, then SWR revalidates as usual.
  const once = `${section}:${workspaceId ?? ''}`
  if (!reads || started.has(once) || (!workspaceId && !['security', 'notifications', 'logins', 'connections'].includes(section))) return
  started.add(once)
  for (const [key, read] of reads(workspaceId ?? '')) {
    // A key SWR already holds belongs to a section that has been open: a preload
    // nobody takes would be handed to that section's next revalidation, stale.
    if (cache.get(unstable_serialize(key as never)) !== undefined) continue
    void preload(key as never, read).catch(() => {})
  }
}

/**
 * Every section the viewer can open, fetched once while the page is idle, so
 * no section shows a skeleton after Settings has opened. The reads are GETs:
 * they run alongside a save instead of queuing in front of it. Hover still
 * fetches a section sooner when the person gets there first.
 */
/** Once the app is idle, the 插件 list's state, so the rail's 插件 page opens on it. */
export function prefetchConnectedApps(cache: Cache) {
  return whenIdle(() => prefetchSettingsSection('connections', undefined, cache))
}

function whenIdle(run: () => void) {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(run, { timeout: 2000 })
    return () => window.cancelIdleCallback(handle)
  }
  const timer = window.setTimeout(run, 200)
  return () => window.clearTimeout(timer)
}

export function prefetchAllSettings(workspaceId: string, admin: boolean, cache: Cache, personal = false) {
  return whenIdle(() => { for (const { id } of visibleSettingsSections({ admin, personal })) prefetchSettingsSection(id, workspaceId, cache) })
}
