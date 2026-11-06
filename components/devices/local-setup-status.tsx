'use client'

import { useEffect, useRef, useState } from 'react'
import { Check, Loader2, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { LOCAL_TARGET, type SshInstallState } from '@mikka/protocol/bridge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item'
import { CodeBlock, CodeBlockCopyButton, CodeBlockHeader } from '@/components/reui/code-block/code-block'
import { STEPS, stepStates } from '@/lib/device-ssh-view'
import { firstRealError } from '@/lib/local-setup-failure'
import { bridgeFromWindow, type MikkaWindow } from '@/lib/platform/detect'

/**
 * This computer becoming a device on its own (Alex, 2026-11-02;
 * DesktopIntegration starts it once per launch). The devices page shows it
 * while it runs, when it comes online, and when it fails, with the reason and
 * 重试. An earlier, finished setup is not shown again.
 */
export function LocalSetupStatus({ onOnline }: { onOnline: () => void }) {
  const t = useTranslations('Devices')
  const [state, setState] = useState<SshInstallState | null>(null)
  const [retrying, setRetrying] = useState(false)
  const onOnlineRef = useRef(onOnline)
  useEffect(() => { onOnlineRef.current = onOnline })

  useEffect(() => {
    const ssh = bridgeFromWindow(window as MikkaWindow)?.ssh
    if (!ssh) return
    let live = true
    void ssh.state().then(current => { if (live && current?.target === LOCAL_TARGET && current.status !== 'online') setState(current) }, () => {})
    const unsubscribe = ssh.onChange(next => {
      if (!live || next.target !== LOCAL_TARGET) return
      setState(next)
      if (next.status === 'online') onOnlineRef.current()
    })
    return () => { live = false; unsubscribe() }
  }, [])

  if (!state) return null
  async function retry() {
    const ssh = bridgeFromWindow(window as MikkaWindow)?.ssh
    if (!ssh?.local || retrying) return
    setRetrying(true)
    try { const next = await ssh.local(); if (next) setState(next) } catch { /* the state keeps the last reason */ } finally { setRetrying(false) }
  }
  const steps = stepStates(state)
  const current = STEPS.find(step => steps[step] === 'running' || steps[step] === 'failed')
  return <Item variant="outline" role="status" aria-live="polite" className="rounded-xl bg-card px-3.5 py-3">
    <ItemMedia>
      {state.status === 'online' ? <Check aria-hidden="true" className="text-success-foreground" />
        : state.status === 'failed' ? <X aria-hidden="true" className="text-destructive-foreground" />
          : <Loader2 aria-hidden="true" className="animate-spin text-muted-foreground motion-reduce:animate-none" />}
    </ItemMedia>
    <ItemContent className="min-w-0">
      <ItemTitle>{state.status === 'online' ? t('local.online') : state.status === 'failed' ? t('local.failed') : t('local.adding')}</ItemTitle>
      {state.status === 'failed' && state.reason
        ? <SetupFailure reason={state.reason} />
        : state.status === 'running' && current && <ItemDescription>{t(`ssh.steps.${current}`)}</ItemDescription>}
    </ItemContent>
    {state.status === 'failed' && <ItemActions><Button size="sm" variant="secondary" disabled={retrying} onClick={() => { void retry() }}>{t('local.retry')}</Button></ItemActions>}
  </Item>
}

/**
 * The failure as a person reads it: the real error line(s) without npm's
 * warnings, wrapped, not truncated. The whole output folds under 查看完整日志,
 * copyable. Copy per failure code follows once the installer reports codes (#1517).
 */
function SetupFailure({ reason }: { reason: string }) {
  const t = useTranslations('Devices')
  const summary = firstRealError(reason) || reason
  return <>
    <ItemDescription className="line-clamp-none whitespace-pre-line break-words text-destructive-foreground">{summary}</ItemDescription>
    {summary !== reason.trim() && <Collapsible>
      <CollapsibleTrigger render={<Button variant="link" size="xs" className="h-auto px-0 py-0.5 text-xs text-muted-foreground" />}>{t('local.details')}</CollapsibleTrigger>
      <CollapsibleContent className="pt-1.5">
        <CodeBlock code={reason.trim()} highlight={false} defaultWrap maxLines={14} className="border-0 bg-muted [--code-block-bg:var(--muted)]">
          <CodeBlockHeader className="border-b-0">
            <CodeBlockCopyButton className="ml-auto" labels={{ copy: t('local.copyLog'), copied: t('local.logCopied') }} />
          </CodeBlockHeader>
        </CodeBlock>
      </CollapsibleContent>
    </Collapsible>}
  </>
}
