'use client'

// #1735 slice A: the thread's Plan / Execute / Ask choice. The picker lives in
// the thread header through the `thread-header` slot's optional `mode` prop;
// the composer keeps a notice that says what the mode means. The control shows
// the mode the server stored; while an unfinished run keeps its frozen mode it
// is read-only, so the UI never shows a mode a run cannot have.
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ThreadModePickerView, ThreadModeTransitionError } from '@/lib/thread-mode/view'
import type { ThreadMode } from '@mikka/protocol/thread-mode'

export interface ThreadModePickerContentProps {
  view: ThreadModePickerView
  /** A transition is in flight: the group is disabled, the request is the only change. */
  pending?: boolean
  onChange?: (mode: ThreadMode) => void
}

/** The presentational picker the panel puts in the thread header. */
export function ThreadModePickerContent({ view, pending = false, onChange }: ThreadModePickerContentProps) {
  const t = useTranslations('IssueThreads.mode')
  const disabled = view.locked || pending
  const group = <ToggleGroup aria-label={t('label')} variant="segment" spacing={0.5} value={[view.mode]} disabled={disabled}
    onValueChange={values => {
      const next = values[0]
      if (next && next !== view.mode) onChange?.(next as ThreadMode)
    }}>
    {view.options.map(option => <ToggleGroupItem key={option.mode} value={option.mode} disabled={option.disabled}>{t(option.mode)}</ToggleGroupItem>)}
  </ToggleGroup>
  return <div data-slot="thread-mode" data-locked={view.locked ? '' : undefined} aria-busy={pending || undefined} className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
    {/* A disabled group still needs its reason; the wrapper is what receives the tooltip. */}
    {view.locked
      ? <Tooltip><TooltipTrigger render={<span className="inline-flex min-w-0" tabIndex={0} aria-label={t('locked')} />}>{group}</TooltipTrigger><TooltipContent side="bottom">{t('locked')}</TooltipContent></Tooltip>
      : group}
    {view.frozenMode && <Badge variant="secondary" data-thread-mode-frozen="">{t('frozen', { mode: t(view.frozenMode) })}</Badge>}
    {pending && <Spinner aria-hidden="true" />}
  </div>
}

export interface ThreadModeNoticeContentProps {
  view: ThreadModePickerView | null
  /** The last refused transition, if any; a 409 means the read needs a refresh, not a retry. */
  error?: ThreadModeTransitionError | null
}

/** What the mode means, above the composer; the picker itself is in the header. */
export function ThreadModeNoticeContent({ view, error = null }: ThreadModeNoticeContentProps) {
  const t = useTranslations('IssueThreads.mode')
  if (!view) return null
  const text = view.mode === 'plan' ? t('planNotice') : view.mode === 'ask' ? t('askNotice') : t('executeNotice')
  return <div data-slot="thread-mode-notice" className="flex min-w-0 flex-col gap-0.5 px-1 text-xs text-muted-foreground">
    <p>{text}{view.locked ? ` ${t('locked')}` : ''}</p>
    {error && <p role="alert" className="text-destructive-foreground">{t(error)}</p>}
  </div>
}
