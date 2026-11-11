'use client'

import { settingsKeys } from '@/lib/swr/keys'
import { useCallback, useEffect, useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { openBillingPortal, startPlanCheckout, type getBilling } from '@/app/actions/billing'
import { settingsRead } from '@/lib/settings-read'
import { ReadResponseError } from '@/lib/swr/retry'
import { getCreditBilling, readCardVerification, startCardVerification, startPointsPurchase, type CardVerificationStatus, type CreditBillingView } from '@/lib/billing/verification-client'
import type { BillingView } from '@/lib/billing/service'
import { useLiveWait } from '@/hooks/use-live-wait'
import { useActionError } from '@/lib/use-action-error'

/**
 * 计费's reads and actions, shared by the open-source page and a UI layer's
 * (`settings-billing` slot). Payment details never pass through here: the plan
 * goes through Stripe Checkout, payment method, plan changes and invoices
 * through the Customer Portal, 充值 and card verification through Checkout.
 */

export const creditBillingKey = settingsKeys.creditBilling
export const cardVerificationKey = settingsKeys.cardVerification

/** `code (detail)` for 详情 when a read fails (decision 2026-11-05-0330); never an upstream message. */
function readFailure(name: string, error: unknown) {
  return `${name} (${error instanceof ReadResponseError ? `http_${error.status}` : error instanceof Error ? error.name : 'unknown'})`
}

/** Drops Checkout's return parameters so a reload does not replay the return. */
function takeReturn(name: string): string | null {
  const url = new URL(window.location.href)
  const value = url.searchParams.get(name)
  if (value === null) return null
  url.searchParams.delete(name)
  url.searchParams.delete('session_id')
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  return value
}

export type BillingPlanState = {
  /** Undefined until the first read answers, and after a failed read. */
  plan: BillingView | undefined
  loading: boolean
  /** The read failed: the words to show. */
  error: string | null
  /** The raw code behind `error`, for 详情. */
  errorCode: string | null
  /** Which redirect is on its way. */
  pending: 'portal' | 'checkout' | null
  /** The last redirect failed: the words to show. */
  actionError: string | null
  /** Customer Portal: payment method, plan changes, invoices. */
  openPortal: () => void
  /** Stripe Checkout for the team plan. */
  startCheckout: () => void
  /** Reads the plan again (重试 after a failed read). */
  reload: () => void
}

/** V15 计费's plan (admins). */
export function useBillingPlan(workspaceId: string): BillingPlanState {
  const actionError = useActionError()
  const billing = useSWR(settingsKeys.billing(workspaceId), () => settingsRead<Awaited<ReturnType<typeof getBilling>>>('billing', { workspace: workspaceId }))
  const [pending, setPending] = useState<'portal' | 'checkout' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const plan = billing.data && !billing.data.error ? billing.data : undefined
  const errorCode = billing.data?.error ?? (billing.error ? readFailure('billing_read_failed', billing.error) : null)

  async function redirect(kind: 'portal' | 'checkout') {
    setPending(kind)
    setError(null)
    try {
      const back = window.location.href
      const result = kind === 'portal' ? await openBillingPortal(back, workspaceId) : await startPlanCheckout(back, workspaceId)
      if (result.error) { setError(actionError(result.error)); setPending(null); return }
      window.location.assign(result.url)
    } catch {
      setError(actionError('billingProviderFailed'))
      setPending(null)
    }
  }

  return {
    plan, loading: !billing.data && !billing.error, error: errorCode ? actionError(billing.data?.error) : null, errorCode,
    pending, actionError: error, openPortal: () => void redirect('portal'), startCheckout: () => void redirect('checkout'),
    reload: () => void billing.mutate(),
  }
}

export type CreditBalanceState = {
  /** 余额 in points and 账单记录; undefined until read, or when the read failed. */
  credits: CreditBillingView | undefined
  /** 充值 is on its way to Stripe. */
  redirecting: boolean
  /** 充值 in USD; one of POINTS_PURCHASE_AMOUNTS. */
  topUp: (amount: number) => void
  reload: () => void
}

/**
 * 计费 › 余额 and 账单记录 (#559): one balance in points, the card-verification
 * $1 included. On `?topup=success` the balance and history reload.
 */
export function useCreditBalance(workspaceId: string): CreditBalanceState {
  const t = useTranslations('Billing.balance')
  const actionError = useActionError()
  const billing = useSWR(creditBillingKey(workspaceId), () => getCreditBilling(workspaceId))
  const { mutate } = billing
  const [redirecting, setRedirecting] = useState(false)

  useEffect(() => {
    const topup = takeReturn('topup')
    if (topup === 'success') { toast.success(t('paid')); void mutate() }
  }, [mutate, t])

  async function topUp(amount: number) {
    setRedirecting(true)
    try {
      const result = await startPointsPurchase(workspaceId, amount)
      if (result.error) { setRedirecting(false); toast.error(result.error === 'billingNotConfigured' ? t('unavailable') : actionError(result.error)); return }
      window.location.assign(result.url)
    } catch {
      setRedirecting(false)
      toast.error(actionError('billingProviderFailed'))
    }
  }

  return { credits: billing.data && !billing.data.error ? billing.data : undefined, redirecting, topUp: amount => void topUp(amount), reload: () => void mutate() }
}

export type FreeAllowanceState = {
  /** Undefined until read, or when the read failed. */
  status: CardVerificationStatus | undefined
  /** A failed status read is distinct from a verified or inapplicable allowance. */
  error?: string | null
  reload?: () => void
  /** Back from Checkout, waiting for the webhook (正在确认…). */
  confirming: boolean
  /** 验证 is on its way to Stripe. */
  redirecting: boolean
  verify: () => void
}

/**
 * 计费 › 免费额度 (#558), personal workspaces only. 验证 goes to Stripe Checkout
 * in setup mode; on `?verify=success` it waits for the webhook's push, then
 * calls `onVerified`.
 */
export function useFreeAllowance(workspaceId: string, enabled: boolean, onVerified?: () => void): FreeAllowanceState {
  const t = useTranslations('Billing.allowance')
  const actionError = useActionError()
  const status = useSWR(enabled ? cardVerificationKey(workspaceId) : null, () => readCardVerification(workspaceId))
  const [confirming, setConfirming] = useState(false)
  const [redirecting, setRedirecting] = useState(false)

  // Back from Checkout: the webhook's commit pushes this workspace's hosted_billing key (#1212); no timer reads it.
  const verified = useCallback((read: Awaited<ReturnType<typeof readCardVerification>>) => !read.error && read.status === 'verified', [])
  const waitForWebhook = useLiveWait(status, 'hosted_billing', workspaceId, cardVerificationKey(workspaceId), verified)
  useEffect(() => {
    if (!enabled || takeReturn('verify') !== 'success') return
    setConfirming(true)
    void waitForWebhook().then(read => {
      setConfirming(false)
      if (!read || read.error || read.status !== 'verified') return
      toast.success(read.allowance === 'claimed_elsewhere' ? t('claimedElsewhere') : t('verified'))
      onVerified?.()
    })
  }, [enabled, workspaceId, waitForWebhook, onVerified, t])

  async function verify() {
    setRedirecting(true)
    try {
      const result = await startCardVerification(workspaceId)
      if (result.error) { setRedirecting(false); toast.error(result.error === 'billingNotConfigured' ? t('unavailable') : actionError(result.error)); return }
      window.location.assign(result.url)
    } catch {
      setRedirecting(false)
      toast.error(actionError('billingProviderFailed'))
    }
  }

  const errorCode = enabled ? status.data?.error ?? (status.error ? readFailure('card_verification_read_failed', status.error) : null) : null
  return { status: status.data && !status.data.error ? status.data : undefined, error: errorCode ? actionError(status.data?.error) : null,
    reload: () => { void status.mutate() }, confirming, redirecting, verify: () => void verify() }
}
