'use client'

import { lazy, Suspense, useCallback, useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { toast } from 'sonner'
import { useTranslations } from '@/lib/intl/i18n-client'
import { getBotModelMenu } from '@/app/actions/execution-settings'
import { getHostedUsage, startPlanCheckout } from '@/app/actions/billing'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { botModelMenuKey } from '@/components/coordinator/bot-model-picker'
import { Link } from '@/i18n/navigation'
import { balancePoints } from '@/lib/billing/hosted-usage'
import type { BotModelMenu } from '@/lib/bot-model-menu-view'
import { settingsHref } from '@/lib/settings-sections'
import { useActionError } from '@/lib/use-action-error'

// Loaded only when the dialog opens: the chat never pays for Stripe's checkout code up front.
const TopUpInPlace = lazy(() => import('@/components/billing/top-up-in-place').then(module => ({ default: module.TopUpInPlace })))

/** What a send would spend from Mikka 额度: the chat's model, a Cloudflare machine, or nothing. */
export type PaywallSpend = { model?: boolean; machine?: boolean }
type HostedUsageRead = Exclude<Awaited<ReturnType<typeof getHostedUsage>>, { error: unknown }>

/**
 * The send-time paywall (decision 2026-11-15-1900, as Capy): a message or task that
 * would spend Mikka 额度 while the workspace has no plan and no balance is not sent;
 * 选择套餐 opens instead. Own subscriptions, keys and devices are never stopped here.
 * The balance counts members' shared credits (the model menu's hosted points) and
 * never blocks a self-hosted server, whose own provider pays.
 */
export function usePaywall(botId: string | null) {
  // The composer already reads this menu (same key); the balance is read only when a send would spend Mikka 额度,
  // so an idle page makes no billing read (no new polling, idle request budget).
  const menu = useSWR<BotModelMenu>(botModelMenuKey(botId), () => getBotModelMenu(botId))
  const [read, setRead] = useState<HostedUsageRead | null>(null)
  const [open, setOpen] = useState(false)
  const blocked = useCallback(async (spend: PaywallSpend) => {
    const hosted = menu.data?.groups?.find(group => group.kind === 'hosted')
    if (hosted?.hostedSource) return false
    const spendsModel = Boolean(spend.model) && menu.data?.current?.kind === 'hosted'
    if (!spendsModel && !spend.machine) return false
    if ((hosted?.points ?? 0) > 0) return false
    // Unknown when the read fails: let the server decide; it refuses with the same card.
    const usage = await getHostedUsage().catch(() => null)
    if (!usage || 'error' in usage && usage.error) return false
    if (balancePoints(usage.balance) > 0) return false
    setRead(usage)
    setOpen(true)
    return true
  }, [menu.data])
  const dialog = <PlanDialog open={open} onOpenChange={setOpen} botId={botId} admin={read?.admin ?? false} workspaceId={read?.workspaceId} onPaid={() => { setOpen(false); setRead(null); void menu.mutate() }} />
  return { blocked, dialog }
}

function PlanDialog({ open, onOpenChange, botId, admin, workspaceId, onPaid }: { open: boolean; onOpenChange: (open: boolean) => void; botId: string | null; admin: boolean; workspaceId?: string; onPaid: () => void }) {
  const t = useTranslations('Billing.paywall')
  const balance = useTranslations('Billing.balance')
  const actionError = useActionError()
  const [pending, setPending] = useState(false)
  async function subscribe() {
    if (pending) return
    setPending(true)
    try {
      const result = await startPlanCheckout(window.location.href, workspaceId)
      if (result.error) { toast.error(actionError(result.error)); return }
      window.location.assign(result.url)
    } catch { toast.error(actionError('billingProviderFailed')) } finally { setPending(false) }
  }
  let actions: ReactNode
  if (admin) actions = <>
    <Suspense fallback={null}><TopUpInPlace botId={botId} label={balance('topUp')} onPaid={onPaid} /></Suspense>
    <Button size="sm" disabled={pending} onClick={() => void subscribe()}>{t('subscribe')}</Button>
  </>
  else actions = <Button size="sm" variant="outline" nativeButton={false} role="link" render={<Link href={settingsHref('billing')} />}>{t('openBilling')}</Button>
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent data-paywall="" className="sm:max-w-sm">
      <DialogTitle>{t('title')}</DialogTitle>
      <div className="flex flex-col gap-1 rounded-xl border p-4">
        <span className="text-sm font-medium">{t('plan')}</span>
        <span className="text-sm text-muted-foreground">{t('price')}</span>
        <span className="text-xs text-muted-foreground">{t('caption')}</span>
      </div>
      {!admin && <p role="status" className="text-sm text-muted-foreground">{t('member')}</p>}
      <div className="flex flex-wrap justify-end gap-2">{actions}</div>
    </DialogContent>
  </Dialog>
}

/**
 * A thread stopped because Mikka 额度 ran out (the gateway's refusal or an unpaid
 * machine): 充值 and 选择套餐 for whoever pays here, 请管理员充值 for a member.
 */
export function CreditsRefusalActions() {
  const t = useTranslations('Billing.refusal')
  const usage = useSWR(['hosted-usage'], () => getHostedUsage())
  const read = usage.data && !usage.data.error ? usage.data : null
  if (!read) return null
  if (!read.admin) return <span className="text-xs text-muted-foreground">{t('askAdmin')}</span>
  return <>
    <Button variant="outline" size="xs" nativeButton={false} role="link" render={<Link href={settingsHref('billing')} />}>{t('topUp')}</Button>
    <Button variant="outline" size="xs" nativeButton={false} role="link" render={<Link href={settingsHref('billing')} />}>{t('choosePlan')}</Button>
  </>
}
