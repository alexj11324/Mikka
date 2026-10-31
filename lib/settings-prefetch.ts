import { preload, type ScopedMutator } from 'swr'
import { unstable_serialize as infiniteKey } from 'swr/infinite'
import { listAuditLog } from '@/app/actions/audit-log'
import { auditPageKey } from '@/components/settings/audit-log-settings'
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
}

/** Paged sections read through useSWRInfinite, which preload does not feed: their first page is written to the cache. */
const FIRST_PAGES: Partial<Record<SettingsSectionId, (workspaceId: string) => [key: string, read: () => Promise<unknown[]>]>> = {
  audit: id => [infiniteKey(auditPageKey(id, 'all')), async () => [await listAuditLog({ filter: 'all', cursor: null }, id)]],
}

const started = new Set<string>()

export function prefetchSettingsSection(section: SettingsSectionId, workspaceId: string | undefined, mutate: ScopedMutator) {
  const reads = READS[section] ?? (FIRST_PAGES[section] ? () => [] : undefined)
  // Workspace sections need the workspace; a section is fetched once per page, then SWR revalidates as usual.
  const once = `${section}:${workspaceId ?? ''}`
  if (!reads || started.has(once) || (!workspaceId && !['security', 'notifications', 'logins'].includes(section))) return
  started.add(once)
  for (const [key, read] of reads(workspaceId ?? '')) void preload(key as never, read).catch(() => {})
  const firstPage = FIRST_PAGES[section]?.(workspaceId ?? '')
  // Pages already in the cache (the section was opened first) are kept.
  if (firstPage) void mutate(firstPage[0], async (current?: unknown[]) => current ?? await firstPage[1](), { revalidate: false }).catch(() => {})
}

/**
 * Every section the viewer can open, fetched once while the page is idle, so
 * no section shows a skeleton after Settings has opened. Hover still fetches
 * a section sooner when the person gets there first.
 */
export function prefetchAllSettings(workspaceId: string, admin: boolean, mutate: ScopedMutator) {
  const run = () => { for (const { id } of visibleSettingsSections({ admin })) prefetchSettingsSection(id, workspaceId, mutate) }
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(run, { timeout: 2000 })
    return () => window.cancelIdleCallback(handle)
  }
  const timer = window.setTimeout(run, 200)
  return () => window.clearTimeout(timer)
}
