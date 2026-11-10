'use client'
import { useEffect, useRef, useState } from 'react'
import useSWR from 'swr'
import { useLocale } from 'next-intl'
import { useActionError } from '@/lib/use-action-error'
import { billingManagementRequest, BillingManagementError, billingManagementPath } from '@/lib/billing/management-client'
import type { BillingManagementOperation, BillingManagementView, BillingScope } from '@/lib/billing/management-contract'
import type { BillingPlanState, CreditBalanceState } from './use-billing'
import { bridgeFromWindow, type MikkaWindow } from '@/lib/platform/detect'

export function useBillingManagement(initial: BillingScope) {
  const [selected, setSelected] = useState<BillingScope | null>(null)
  const scope = selected ?? initial
  const [budgetWorkspaceId, setBudgetWorkspaceId] = useState<string | null>(null)
  const [pending, setPending] = useState<BillingManagementOperation['action'] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const actionError = useActionError(), locale = useLocale()
  const read = useSWR(billingManagementPath(scope, budgetWorkspaceId), () => billingManagementRequest(scope, undefined, budgetWorkspaceId))
  const alive = useRef(true), writing = useRef(false), currentScope = useRef(scope)
  const externalReturn = useRef<BillingScope | null>(null)
  currentScope.current = scope
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    const url = new URL(window.location.href)
    if (!url.searchParams.has('topup') && !url.searchParams.has('billing_return')) return
    url.searchParams.delete('topup'); url.searchParams.delete('session_id'); url.searchParams.delete('billing_return')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
    // The return parameter is not a payment receipt. Only a fresh ledger read is authoritative.
    void read.mutate()
  }, [read.mutate])
  useEffect(() => {
    const returned = () => {
      const expected = externalReturn.current
      if (expected && expected.kind === scope.kind && expected.id === scope.id) { externalReturn.current = null; void read.mutate() }
    }
    window.addEventListener('focus', returned)
    return () => window.removeEventListener('focus', returned)
  }, [scope.kind, scope.id, read.mutate])
  const denied = read.error instanceof BillingManagementError && [401, 403].includes(read.error.status)
  const data = denied ? undefined : read.data
  const selectScope = (next: BillingScope) => { if (writing.current) return; externalReturn.current = null; setSelected(next); setBudgetWorkspaceId(null); setError(null) }
  async function save(operation: BillingManagementOperation) {
    if (writing.current) return false
    writing.current = true
    setPending(operation.action); setError(null)
    try {
      const pinned = ['checkout', 'portal', 'topup', 'recharge'].includes(operation.action) ? { ...operation, accountWorkspaceId: data?.account?.workspaceId } : operation
      const result = await billingManagementRequest<{ url?: string }>(scope, pinned)
      if (!alive.current || currentScope.current.kind !== scope.kind || currentScope.current.id !== scope.id) return false
      if (result.url) {
        const bridge = bridgeFromWindow(window as MikkaWindow)
        if (bridge) { externalReturn.current = scope; await bridge.app.openExternal(result.url) }
        else window.location.assign(result.url)
      } else await read.mutate()
      return true
    } catch (failure) {
      if (alive.current && currentScope.current.kind === scope.kind && currentScope.current.id === scope.id) setError(actionError(failure instanceof BillingManagementError ? failure.code : 'generic'))
      return false
    } finally { writing.current = false; if (alive.current) setPending(null) }
  }
  const plan: BillingPlanState = { plan: data?.billing ?? undefined, loading: read.isLoading,
    error: read.error ? actionError(read.error instanceof BillingManagementError ? read.error.code : 'generic') : null,
    errorCode: read.error instanceof BillingManagementError ? read.error.code : read.error ? 'billing_read_failed' : null,
    pending: pending === 'checkout' || pending === 'portal' ? pending : null, actionError: error,
    openPortal: () => { void save({ action: 'portal' }) }, startCheckout: () => { void save({ action: 'checkout' }) }, reload: () => { void read.mutate() } }
  const balance: CreditBalanceState = { credits: data?.credits ?? undefined, redirecting: pending === 'topup',
    topUp: amount => { void save({ action: 'topup', amount, locale: locale === 'en' ? 'en' : 'zh-CN' }) }, reload: () => { void read.mutate() } }
  return { data: data as BillingManagementView | undefined, scope, selectScope, budgetWorkspaceId, setBudgetWorkspaceId,
    loading: read.isLoading, readError: plan.error, error, pending, save, reload: plan.reload, plan, balance }
}
export type BillingManagementState = ReturnType<typeof useBillingManagement>
