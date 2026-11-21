'use client'

import useSWR from 'swr'
import { useTranslations } from '@/lib/intl/i18n-client'
import { BillingPage } from '@ui-slot/settings-billing'
import { useGatedFeature } from '@/hooks/use-feature-availability'
import { useBillingManagement } from '@/hooks/settings/use-billing-management'
import type { BillingScope } from '@/lib/billing/management-contract'
import { withBasePath } from '@/lib/base-path'
import { useActionError } from '@/lib/use-action-error'
import { SettingsLoading, SettingsSaveError } from './primitives'
import { BillingManagementError } from '@/lib/billing/management-client'

/**
 * V15 计费: reads and Stripe redirects here (hooks/settings/use-billing.ts); the
 * page is the settings-billing slot.
 */
export function BillingSettings({ workspaceId, admin = true }: { workspaceId: string; personal?: boolean; admin?: boolean }) {
  return admin ? <BillingContext key={workspaceId} scope={{ kind: 'workspace', id: workspaceId }} /> : <OrganizationBillingEntry />
}

/** An Organization admin does not need a Workspace admin role to reach finance metadata. */
function OrganizationBillingEntry() {
  const t = useTranslations('Common'), actionError = useActionError()
  const read = useSWR('/api/organizations', async path => {
    const response = await fetch(withBasePath(path), { credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) throw new BillingManagementError([401, 403].includes(response.status) ? 'workspaceAccessDenied' : 'generic', response.status)
    return response.json() as Promise<{ organizations: { id: string; role: 'owner' | 'admin' | 'member' }[] }>
  })
  if (read.error) return <SettingsSaveError message={actionError(read.error instanceof BillingManagementError ? read.error.code : 'generic')} retryLabel={t('retry')} onRetry={() => void read.mutate()} />
  if (!read.data) return <SettingsLoading label={t('loading')} rows={1} bare />
  const organization = read.data.organizations.find(row => row.role === 'owner' || row.role === 'admin')
  return organization ? <OrganizationBillingSettings organizationId={organization.id} /> : null
}

/** The same Billing page inside Organization settings; no additional settings system. */
export function OrganizationBillingSettings({ organizationId }: { organizationId: string }) {
  return <BillingContext key={organizationId} scope={{ kind: 'organization', id: organizationId }} />
}

function BillingContext({ scope }: { scope: BillingScope }) {
  const computerBilling = useGatedFeature('computerBilling')
  const management = useBillingManagement(scope)
  const { plan, balance } = management
  // No card verification or free allowance any more (decision 2026-11-15-1900).
  return <BillingPage plan={plan} balance={balance} allowance={null} computerBilling={computerBilling} management={management} />
}
