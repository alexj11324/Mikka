'use client'

// #1735 slice A: the thread's Plan / Execute / Ask choice above the composer.
// The control shows the mode the server stored; while an unfinished run keeps
// its frozen mode it is read-only, so the UI never shows a mode a run cannot
// have. The run's frozen mode is a read-only badge in the header.
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useThreadMode } from '@/hooks/use-thread-mode'
import { frozenThreadMode, threadModePicker, type ThreadModePickerView, type ThreadModeTransitionError } from '@/lib/thread-mode/view'
import type { ThreadMode } from '@mikka/protocol/thread-mode'

export interface ThreadModePickerContentProps {
  view: ThreadModePickerView
  /** A transition is in flight: the group is disabled, the request is the only change. */
  pending?: boolean
  error?: ThreadModeTransitionError | null
  onChange?: (mode: ThreadMode) => void
}

/** The presentational picker, shared by the panel and its SSR tests. */
export function ThreadModePickerContent({ view, pending = false, error = null, onChange }: ThreadModePickerContentProps) {
  const t = useTranslations('IssueThreads.mode')
  const disabled = view.locked || pending
  const group = <ToggleGroup aria-label={t('label')} variant="segment" spacing={0.5} value={[view.mode]} disabled={disabled}
    onValueChange={values => {
      const next = values[0]
      if (next && next !== view.mode) onChange?.(next as ThreadMode)
    }}>
    {view.options.map(option => <ToggleGroupItem key={option.mode} value={option.mode} disabled={option.disabled}>{t(option.mode)}</ToggleGroupItem>)}
  </ToggleGroup>
  return <div data-slot="thread-mode" data-locked={view.locked ? '' : undefined} aria-busy={pending || undefined} className="flex min-w-0 flex-wrap items-center gap-2 px-1 text-xs">
    <span className="shrink-0 text-muted-foreground">{t('label')}</span>
    {group}
    {view.locked && <span className="text-muted-foreground">{t('locked')}</span>}
    {pending && <Spinner aria-hidden="true" />}
    {error && <span role="alert" className="text-destructive-foreground">{t(error)}</span>}
  </div>
}

/** The header's read-only badge: what the displayed run actually froze. */
export function ThreadModeFrozenBadgeContent({ mode }: { mode: ThreadMode | null }) {
  const t = useTranslations('IssueThreads.mode')
  if (!mode) return null
  return <Badge variant="secondary" data-thread-mode-frozen="">{t('frozen', { mode: t(mode) })}</Badge>
}

export function ThreadModeFrozenBadge({ runId, liveRunId }: { runId: string; liveRunId?: string }) {
  const { state } = useThreadMode(runId, liveRunId)
  return <ThreadModeFrozenBadgeContent mode={frozenThreadMode(state)} />
}

/**
 * The thread mode control for one run. `active` is the panel's read of the
 * displayed run; the server's `locked` also covers another attempt of the
 * same task running.
 */
export function ThreadModePicker({ runId, liveRunId, active }: { runId: string; liveRunId?: string; active: boolean }) {
  const { state, transition } = useThreadMode(runId, liveRunId)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ThreadModeTransitionError | null>(null)
  const current = threadModePicker(state, active)
  if (!current) return null
  async function change(mode: ThreadMode) {
    if (pending || current.locked) return
    setPending(true)
    setError(null)
    const result = await transition(mode)
    if ('error' in result) setError(result.error)
    setPending(false)
  }
  return <ThreadModePickerContent view={current} pending={pending} error={error} onChange={mode => { void change(mode) }} />
}
