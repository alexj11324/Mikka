import { preload, unstable_serialize, type Cache } from 'swr'
import { listAuditLog } from '@/app/actions/audit-log'
import { getPasswordStatus, listSessions } from '@/app/actions/account'
import { getPreferences } from '@/app/actions/preferences'
import { listSavedLogins } from '@/app/actions/settings-activity'
import { getWorkspaceGeneral } from '@/app/actions/workspace-settings'
import { getAppPolicy } from '@/app/actions/app-policy'
import { getE2BKey, listSecrets } from '@/app/actions/workspace-secrets'
import { getUsage } from '@/app/actions/usage'
import { getBilling } from '@/app/actions/billing'
import { getCreditBilling } from '@/lib/billing/verification-client'
import { creditBillingKey } from '@/components/billing/balance-section'
import { currentMonth } from '@/lib/usage/month'
import { computerPolicyKey, readComputerPolicy } from '@/components/settings/computer-policy-settings'
import { cardVerificationKey } from '@/components/billing/free-allowance-section'
import { cardVerificationStatus } from '@/lib/billing/verification-client'
import { visibleSettingsSections, type SettingsSectionId } from '@/lib/settings-sections'

/**
 * The first read of each section, with the same SWR keys and calls the section
 * uses, so hovering its sidebar item fills the cache before the click and the
 * section opens without a skeleton. Keep a key here in step with its section.
 */
const READS: Partial<Record<SettingsSectionId, (workspaceId: string) => [key: unknown, read: () => Promise<unknown>][]>> = {
  security: () => [['account:password', getPasswordStatus], ['account:sessions', listSessions]],
  notifications: () => [['preferences', getPreferences]],
  logins: () => [['account:saved-logins', listSavedLogins]],
  general: id => [[['workspace:general', id], () => getWorkspaceGeneral(id)]],
  permissions: id => [[computerPolicyKey(id), () => readComputerPolicy(id)], [['settings:app-policy', id], () => getAppPolicy(id)]],
  secrets: id => [[['settings:secrets', id], () => listSecrets(id)], [['settings:e2b-key', id], () => getE2BKey()]],
  usage: id => { const month = currentMonth(); return [[['settings:usage', id, month], () => getUsage(month, id)], [creditBillingKey(id), () => getCreditBilling(id)]] },
  billing: id => [[['settings:billing', id], () => getBilling(id)], [creditBillingKey(id), () => getCreditBilling(id)], [cardVerificationKey(id), () => cardVerificationStatus(id)]],
  // useSWRInfinite takes a preloaded page by the page's own key: page one of 全部.
  audit: id => [[['settings:audit', id, 'all', null], () => listAuditLog({ filter: 'all', cursor: null }, id)]],
}

const started = new Set<string>()

export function prefetchSettingsSection(section: SettingsSectionId, workspaceId: string | undefined, cache: Cache): Promise<unknown> {
  const reads = READS[section]
  // Workspace sections need the workspace; a section is fetched once per page, then SWR revalidates as usual.
  const once = `${section}:${workspaceId ?? ''}`
  if (!reads || started.has(once) || (!workspaceId && !['security', 'notifications', 'logins'].includes(section))) return Promise.resolve()
  started.add(once)
  const pending: Promise<unknown>[] = []
  for (const [key, read] of reads(workspaceId ?? '')) {
    // A key SWR already holds belongs to a section that has been open: a preload
    // nobody takes would be handed to that section's next revalidation, stale.
    if (cache.get(unstable_serialize(key as never)) !== undefined) continue
    pending.push(Promise.resolve(preload(key as never, read)).catch(() => {}))
  }
  return Promise.all(pending)
}

const idle = () => new Promise<void>(resolve => {
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(() => resolve(), { timeout: 2000 })
  else window.setTimeout(resolve, 200)
})

/**
 * Every section the viewer can open, fetched while the page is idle, so no
 * section shows a skeleton after Settings has opened. Hover still fetches a
 * section sooner when the person gets there first.
 *
 * One section at a time: Next runs a page's server actions one after another,
 * so a burst of reads would hold back a save made meanwhile. A save waits for
 * at most one section's reads.
 */
export function prefetchAllSettings(workspaceId: string, admin: boolean, cache: Cache) {
  let cancelled = false
  void (async () => {
    for (const { id } of visibleSettingsSections({ admin })) {
      await idle()
      if (cancelled) return
      await prefetchSettingsSection(id, workspaceId, cache)
    }
  })()
  return () => { cancelled = true }
}
