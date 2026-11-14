'use client'

import { useState } from 'react'
import { useClipboardCopy } from '@/hooks/use-clipboard-copy'
import { Check, Copy, MoreHorizontal, RefreshCw, TriangleAlert } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Field, FieldGroup, FieldLabel, FieldError } from '@/components/ui/field'
import { Progress } from '@/components/ui/progress'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Claude } from '@/components/ui/svgs/claude'
import { OpenAI } from '@/components/ui/svgs/openai'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { Skeleton } from '@/components/ui/skeleton'
import { planName, subscriptionSignInState, type SubscriptionUsageView } from '@/lib/subscription-ui'
import { readSubscriptionUsage, readSubscriptions, subscriptionsKey, subscriptionUsageKey, useSubscriptions, type SubscriptionAttempt, type SubscriptionProvider } from '@/hooks/settings/use-subscriptions'
import { cn } from '@/lib/utils'

type Provider = SubscriptionProvider
type Attempt = SubscriptionAttempt
const logos = { codex: OpenAI, claude: Claude } as const

/**
 * The bounded provider ceremony lives on the server; this page resumes it.
 * Authorization URLs and codes never go into chat or browser storage.
 * The subscriptions are their own group on 「API 与订阅」; API keys are the
 * next one (decision 2026-11-02-1200).
 */
/** `heading` replaces the section title where the rows appear outside Settings (the first-run guide's 绑定订阅). */
export function SubscriptionSettings({ workspaceId, heading }: { workspaceId: string; heading?: string }) {
  const t = useTranslations('Settings.subscriptions')
  const { state, loadFailed, attempt, callback, setCallback, catching, pending, starting, error, notice, now, usage, usageLoading, reloadUsage, refreshingModels, refreshModels, connect, finishCallback, cancel, disconnect, setPaused, remove, startAgain } = useSubscriptions(workspaceId)
  // 断开连接 asks first, like deleting an API key (A1).
  const [disconnecting, setDisconnecting] = useState<{ id: string; provider: Provider; revision: number; label: string } | null>(null)


  const status = loadFailed ? <FieldError className="px-1">{t('loadFailed')}</FieldError>
    : !state ? null
      : !state.enabled ? <p role="status" className="px-1 text-sm text-muted-foreground">{t('serviceOff')}</p> : null
  // First visit only: rows the size of the provider rows, so nothing moves when the list arrives.
  if (!state && !loadFailed) return <div role="status" aria-label={t('loading')} className="flex flex-col gap-1">
    <SettingsSection id="subscriptions-heading" title={heading ?? t('heading')}>
      {(['codex', 'claude'] as const).map(provider => <SubscriptionRowSkeleton key={provider} provider={provider} label={t(provider)} />)}
    </SettingsSection>
  </div>
  if (status || !state) return <section className="flex flex-col gap-1" aria-labelledby="subscriptions-heading">
    <h2 id="subscriptions-heading" className="pl-1 text-sm font-medium">{heading ?? t('heading')}</h2>
    {status}
  </section>
  // The oldest read on screen, so the line never overstates how fresh a meter is.
  const reads = usage && usage !== 'failed' ? state.connections.flatMap(connection => {
    const read = connection.state === 'connected' ? usage.get(connection.id) : undefined
    return read && read.status !== 'unavailable' && read.status !== 'reauth' ? [Date.parse(read.observedAt)] : []
  }) : []
  const updated = reads.length > 0 ? Math.max(0, Math.floor((now - Math.min(...reads)) / 60_000)) : null
  return <div className="flex flex-col gap-1">
    <SettingsSection id="subscriptions-heading" title={heading ?? t('heading')}>
      {(['codex', 'claude'] as const).map(provider => {
        const available = state.providers.some(item => item.provider === provider && item.available)
        const connections = state.connections.filter(item => item.provider === provider)
        const Logo = logos[provider]
        const failure = error?.provider === provider ? error : null
        const mine = attempt?.provider === provider ? attempt : null
        return <div key={provider} className="divide-y divide-border">
          <div>
            <div className="divide-y divide-border">
              {connections.length === 0 && <SettingRow icon={<Logo className={cn('size-5 shrink-0 text-foreground', provider === 'claude' && 'text-brand-claude')} />} title={t(provider)} description={available ? undefined : t('unavailable')}>
                <span className="flex items-center gap-2">
                  {mine && catching && <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={cancel}>{t('cancel')}</Button>}
                  <SignInButton busy={(starting?.provider === provider && !starting.id) || !!mine} disabled={!available || pending || !!attempt} label={t('connect')} busyLabel={t('connecting')} onClick={() => { void connect(provider) }} />
                </span>
              </SettingRow>}
              {connections.map(connection => {
                const live = connection.state === 'connected'
                const signInState = subscriptionSignInState(connection, now)
                const resumable = signInState === 'resume' && !(failure?.again?.connectionId === connection.id && failure.again.resume === false)
                const read = live && usage && usage !== 'failed' ? usage.get(connection.id) : undefined
                const failed = live && (usage === 'failed' || read?.status === 'unavailable')
                // reauth: the runtime's own reconnect_required, or the provider refused this read.
                const reauth = connection.state === 'reconnect_required' || read?.status === 'reauth'
                const paused = connection.paused === true
                const healthy = live && !reauth && !paused
                const account = read?.account ?? connection.account ?? null
                const plan = read?.plan ? planName(read.plan) : null
                const product = plan ? t(provider === 'codex' ? 'codexPlan' : 'claudePlan', { plan }) : t(provider === 'codex' ? 'codexProduct' : 'claudeProduct')
                const signingIn = starting?.id === connection.id || attempt?.connectionId === connection.id
                const canReconnect = available && !pending && !attempt
                return <div key={connection.id} id={`subscription-${connection.id}`} tabIndex={-1} className="flex scroll-mt-6 flex-col gap-3 px-5 py-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className={cn('flex min-w-0 items-center gap-3 transition-opacity duration-150', paused && 'opacity-50')}>
                      <Logo className={cn('size-5 shrink-0 text-foreground', provider === 'claude' && 'text-brand-claude')} />
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-sm font-medium">{account ?? product}</span>
                        {account && <span className="text-xs text-muted-foreground">{product}</span>}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-2 sm:justify-end">
                      {/* The 启用 switch says on or off; the label speaks only for other states. */}
                      {!healthy && !(paused && live && !reauth && !signingIn) && <span className="flex items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground">
                        {reauth && <span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />}
                        {signInState === 'expired' ? t('signInExpired') : resumable && !signingIn ? t('unfinished') : reauth ? t('reauth') : paused ? t('paused') : t('notConnected')}
                      </span>}
                      {mine?.connectionId === connection.id && catching && <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={cancel}>{t('cancel')}</Button>}
                      {(reauth || !live || signingIn) && <SignInButton busy={signingIn} disabled={!canReconnect} label={t(resumable ? 'resume' : 'reconnect')} busyLabel={t('connecting')} onClick={() => { void connect(provider, connection, resumable) }} />}
                      {/* 启用, labelled like 设备's 参与调度: off, its models in 优先使用的模型 read 订阅已停用 and no run or chat uses it. */}
                      {live && !reauth && !signingIn && <Label className="flex items-center gap-2 font-normal text-muted-foreground">
                        <span aria-hidden="true" className="max-sm:hidden">{t('enabled')}</span>
                        <Switch checked={!paused} disabled={pending || !!attempt} aria-label={t('useSubscription', { label: account ?? product })} onCheckedChange={checked => { void setPaused(connection, !checked) }} />
                      </Label>}
                      <DropdownMenu>
                        <DropdownMenuTrigger disabled={pending || !!attempt} render={<Button variant="ghost" size="icon-sm" aria-label={t('rowMenu', { label: account ?? product })} />}><MoreHorizontal aria-hidden="true" /></DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuGroup>
                            {healthy && <DropdownMenuItem disabled={refreshingModels === connection.id} onClick={() => { void refreshModels({ id: connection.id, label: account ?? product }) }}><RefreshCw />{t('refreshModels')}</DropdownMenuItem>}
                            {live
                              ? <DropdownMenuItem variant="destructive" onClick={() => setDisconnecting({ ...connection, label: account ?? product })}>{t('disconnect')}</DropdownMenuItem>
                              : <DropdownMenuItem variant="destructive" onClick={() => { void remove(connection) }}>{t('remove')}</DropdownMenuItem>}
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                  {(live || reauth) && <div className={cn('flex flex-col gap-2 transition-opacity duration-150 sm:pl-8', paused && 'opacity-50')}>
                    {failed
                      ? <span className="flex items-center gap-2 text-xs text-muted-foreground">{t('quotaUnavailable')}<Button type="button" variant="secondary" size="xs" disabled={usageLoading} onClick={reloadUsage}>{t('retry')}</Button></span>
                      : read && read.windows.length > 0 && <QuotaMeters windows={read.windows} now={now} />}
                  </div>}
                </div>
              })}
            </div>
            {mine && !catching && <SignInPanel attempt={mine} callback={callback} pending={pending} onCallback={setCallback} onFinish={() => { void finishCallback() }} onCancel={cancel} />}
          </div>
          {failure && <div role="alert" className="flex items-center gap-2 px-5 py-3 text-sm text-warning-foreground">
            <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-warning-foreground" />
            <span className="min-w-0 flex-1">{failure.message}</span>
            {failure.again && available && <Button type="button" variant="secondary" size="sm" disabled={pending || !!attempt} onClick={() => startAgain(failure)}>{t('retry')}</Button>}
          </div>}
        </div>
      })}
    </SettingsSection>
    {updated !== null && <p className="pt-1 pl-1 text-xs text-muted-foreground">{updated < 1 ? t('updatedJustNow') : t('updatedAgo', { minutes: updated })}</p>}
    {notice && <p role="status" className="pt-1 pl-1 text-xs text-muted-foreground">{notice}</p>}
    <AlertDialog open={disconnecting !== null} onOpenChange={open => { if (!open && !pending) setDisconnecting(null) }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>{t('disconnectTitle', { label: disconnecting?.label ?? '' })}</AlertDialogTitle></AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t('cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={pending} onClick={() => { const target = disconnecting; setDisconnecting(null); if (target) void disconnect(target) }}>{t('disconnect')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
}

export { readSubscriptionUsage, readSubscriptions, subscriptionsKey, subscriptionUsageKey }

/** A provider row before the list has ever loaded: the not-connected row, its button still a placeholder. */
function SubscriptionRowSkeleton({ provider, label }: { provider: Provider; label: string }) {
  const Logo = logos[provider]
  return <SettingRow icon={<Logo className={cn('size-5 shrink-0 text-foreground', provider === 'claude' && 'text-brand-claude')} />} title={label}>
    <Skeleton className="h-7 w-14 rounded-md" />
  </SettingRow>
}

/** The rest of a sign-in the browser can't finish for us, inside its provider's row. */
function SignInPanel({ attempt, callback, pending, onCallback, onFinish, onCancel }: { attempt: Attempt; callback: string; pending: boolean; onCallback: (value: string) => void; onFinish: () => void; onCancel: () => void }) {
  const t = useTranslations('Settings.subscriptions')
  const { state: copyState, copy } = useClipboardCopy(attempt.userCode ?? '')
  const copyText = useTranslations('AiElements.message')
  const name = t(attempt.provider === 'codex' ? 'codexProduct' : 'claudeProduct')
  const cancel = <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={onCancel}>{t('cancel')}</Button>
  const open = <Button variant="secondary" size="sm" nativeButton={false} render={<a href={attempt.authorizationUrl} target="_blank" rel="noopener noreferrer" />}>{t('open', { provider: name })}</Button>
  if (attempt.flow === 'device') return <div className="flex flex-col gap-2 px-5 pb-4 sm:pl-13">
    <span className="text-xs font-medium">{t('deviceCode')}</span>
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-xl font-semibold select-all">{attempt.userCode}</span>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={copyState === 'copied' ? t('copied') : t('copy')} disabled={!attempt.userCode || copyState === 'pending'} onClick={copy}>{copyState === 'copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</Button>
      {copyState === 'failed' && <span role="alert">{copyText('copyFailed')}</span>}
      <span className="ml-auto flex items-center gap-2">{cancel}{open}</span>
    </div>
  </div>
  return <form className="flex flex-col gap-3 px-5 pb-4 sm:pl-13" onSubmit={event => { event.preventDefault(); onFinish() }}>
    <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-muted-foreground">
      <li>{t('callbackStepOpen')}</li>
      <li>{t('callbackStepCopy')}</li>
      <li>{t('callbackStepPaste')}</li>
    </ol>
    <FieldGroup><Field><FieldLabel htmlFor="subscription-callback">{t('callbackLabel')}</FieldLabel>
      <Input id="subscription-callback" value={callback} placeholder={t('callbackPlaceholder')} autoComplete="off" spellCheck={false} maxLength={8192} onChange={event => onCallback(event.target.value)} />
    </Field></FieldGroup>
    <div className="flex flex-wrap items-center justify-end gap-2">
      {cancel}{open}
      <Button type="submit" size="sm" disabled={pending || !callback.trim()}>{t('finish')}</Button>
    </div>
  </form>
}

function SignInButton({ busy, disabled, label, busyLabel, onClick }: { busy: boolean; disabled: boolean; label: string; busyLabel: string; onClick: () => void }) {
  // Busy reads as work in progress, not as a dimmed button, and still can't be pressed twice.
  return <Button type="button" variant="secondary" size="sm" className={cn(busy && 'disabled:opacity-100')} disabled={busy || disabled} aria-busy={busy} onClick={onClick}>{busy ? <><Spinner className="size-3.5" aria-hidden="true" />{busyLabel}</> : label}</Button>
}

/** What is left of each window the provider returned, with when it resets. */
function QuotaMeters({ windows, now }: { windows: SubscriptionUsageView['windows']; now: number }) {
  const t = useTranslations('Settings.subscriptions')
  const format = useFormatter()
  return <div className="flex flex-col gap-3 text-xs">
    {windows.map(window => {
      const label = window.model ? t('quotaWeeklyModel', { model: window.model }) : window.kind === 'five_hour' ? t('quotaFiveHour') : t('quotaWeekly')
      const at = window.resetsAt ? Date.parse(window.resetsAt) : NaN
      // Within a day the hour is enough; further out, the date.
      const reset = Number.isFinite(at) ? t('quotaReset', { time: at - now < 86_400_000 ? format.dateTime(at, { hour: '2-digit', minute: '2-digit' }) : format.dateTime(at, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }) : null
      const left = t('quotaLeft', { percent: window.remaining })
      const low = window.remaining < 10
      return <div key={`${window.kind}-${window.model ?? ''}`} className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <span className="text-foreground">{label}</span>
          <span className="flex items-baseline gap-2 whitespace-nowrap tabular-nums">
            {reset && <span className="text-muted-foreground">{reset}</span>}
            <span className={cn('font-medium', low ? 'text-destructive-foreground' : 'text-foreground')}>{left}</span>
          </span>
        </div>
        <Progress value={window.remaining} aria-label={[label, left, reset].filter(Boolean).join(' · ')} className={cn('[&_[data-slot=progress-track]]:h-1.5', low && '[&_[data-slot=progress-indicator]]:bg-destructive')} />
      </div>
    })}
  </div>
}
