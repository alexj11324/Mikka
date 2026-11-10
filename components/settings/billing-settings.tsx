'use client'

import { useCallback } from 'react'
import { BillingPage } from '@ui-slot/settings-billing'
import { useGatedFeature } from '@/hooks/use-feature-availability'
import { useBillingPlan, useCreditBalance, useFreeAllowance } from '@/hooks/settings/use-billing'

/**
 * V15 计费: reads and Stripe redirects here (hooks/settings/use-billing.ts); the
 * page is the settings-billing slot.
 */
export function BillingSettings({ workspaceId, personal = false, admin = true }: { workspaceId: string; /** Card verification belongs to the person: its USD 1 lands in their personal workspace, so only that 计费 offers it (C19). */ personal?: boolean; /** The billing-consistency change (#1852) opens 计费 to Organization admins; until it lands, a non-workspace-admin keeps seeing nothing. */ admin?: boolean }) {
  return admin ? <BillingSettingsPage workspaceId={workspaceId} personal={personal} /> : null
}

function BillingSettingsPage({ workspaceId, personal }: { workspaceId: string; personal: boolean }) {
  const computerBilling = useGatedFeature('computerBilling')
  const plan = useBillingPlan(workspaceId)
  const balance = useCreditBalance(workspaceId)
  const { reload } = balance
  const onVerified = useCallback(() => reload(), [reload])
  const allowance = useFreeAllowance(workspaceId, personal, onVerified)
  return <BillingPage plan={plan} balance={balance} allowance={personal ? allowance : null} computerBilling={computerBilling} />
}
