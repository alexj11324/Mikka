import type { ComponentProps, ReactNode } from 'react'
import { Alert, AlertAction, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

/** S-Q: a section that is still loading keeps its shape instead of rendering nothing. */
export function SettingsLoading({ label, rows = 3 }: { label: string; rows?: number }) {
  return <div role="status" aria-label={label} className="flex flex-col gap-1">
    <span className="sr-only">{label}</span>
    <Skeleton className="mx-1 h-4 w-24" />
    <div className="flex flex-col divide-y divide-border overflow-hidden rounded-2xl border bg-card">
      {Array.from({ length: rows }, (_, i) => <div key={i} className="flex items-center justify-between gap-3 px-5 py-4"><Skeleton className="h-4 w-40" /><Skeleton className="h-6 w-12" /></div>)}
    </div>
  </div>
}

/** S-O: a save that failed. The value is already restored; the button retries the same change. */
export function SettingsSaveError({ message, retryLabel, onRetry }: { message: string; retryLabel: string; onRetry: () => void }) {
  return <Alert variant="destructive" role="alert">
    <AlertDescription>{message}</AlertDescription>
    <AlertAction><Button variant="outline" size="sm" onClick={onRetry}>{retryLabel}</Button></AlertAction>
  </Alert>
}

/**
 * Settings section: a titled group of rows.
 *
 * Deliberately surface-free — no background, border or radius. Rows are
 * separated by hairlines so the settings page reads as one continuous column
 * instead of a stack of cards. A card around a section is the pattern this
 * component exists to prevent.
 */
export function SettingsSection({
  id,
  title,
  description,
  action,
  children,
}: {
  id?: string
  /** Left out when the page title already names the card (常规's first card). */
  title?: string
  description?: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-1" aria-labelledby={title ? id : undefined}>
      {/* The title is inset like the row text; the action has no inset so its
          right edge lines up with the card's right edge below it. */}
      {(title || action) && <header className="flex items-end justify-between gap-3 pl-1">
        <div className="flex min-w-0 flex-col gap-0.5">
          {title && <h2 id={id} className="text-sm font-medium">
            {title}
          </h2>}
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        {action && <div data-settings-section-action className="flex shrink-0 items-center gap-2">{action}</div>}
      </header>}
      <div data-settings-card className="overflow-hidden rounded-2xl border bg-card">
        <div data-settings-rows className="divide-y divide-border">{children}</div>
      </div>
    </section>
  )
}

/**
 * One setting = one row: title and description on the left, value or control
 * on the right.
 *
 * Never give a single row a background, border or radius. If a row needs to
 * look different, change what it contains, not its surface.
 */
export function SettingRow({
  title,
  description,
  icon,
  children,
}: {
  title: string
  description?: string
  /** The named thing's icon (R-74), before the title. */
  icon?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        {icon}
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm leading-snug font-medium text-foreground">{title}</span>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
      </div>
      <div className="shrink-0 text-sm">{children}</div>
    </div>
  )
}

/** Spread on the Button in a section header (添加, 打开设置…): gray-filled secondary, small. */
export const settingsSectionAction = { variant: 'secondary', size: 'sm' } as const satisfies Pick<ComponentProps<typeof Button>, 'variant' | 'size'>
