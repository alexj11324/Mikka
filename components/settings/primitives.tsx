import type { ReactNode } from 'react'
import { FieldLabel } from '@/components/ui/field'
import { cn } from '@/lib/utils'

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
  title: string
  description?: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-1" aria-labelledby={id}>
      <header className="flex items-baseline justify-between gap-3 px-1">
        <div className="flex flex-col gap-0.5">
          <h2 id={id} className="text-sm font-medium">
            {title}
          </h2>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        {action}
      </header>
      <div data-settings-card className="overflow-hidden rounded-2xl border bg-card">
        <div data-settings-rows className="divide-y divide-border">{children}</div>
      </div>
    </section>
  )
}

/**
 * A form section that keeps its context on the left and setting rows on the
 * right at desktop widths, then stacks both parts on smaller screens.
 */
export function SettingsFormSection({
  id,
  title,
  description,
  children,
}: {
  id: string
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <section className="grid gap-2 py-4 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4" aria-labelledby={id}>
      <header className="flex min-w-0 flex-col gap-0.5 px-4 sm:px-5">
        <h3 id={id} className="text-sm font-semibold tracking-tight">{title}</h3>
        <p className="text-xs leading-5 text-muted-foreground">{description}</p>
      </header>
      <div data-settings-rows className="divide-y divide-border">{children}</div>
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
  htmlFor,
  controlLayout = 'standard',
  children,
}: {
  title: string
  description?: string
  htmlFor?: string
  controlLayout?: 'standard' | 'wide' | 'full'
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 px-5 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
      <div className="flex min-w-0 flex-col gap-0.5">
        {htmlFor ? (
          <FieldLabel htmlFor={htmlFor}>{title}</FieldLabel>
        ) : (
          <span className="text-sm font-medium">{title}</span>
        )}
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      <div className={cn(
        'w-full min-w-0 text-sm',
        controlLayout === 'wide' && 'sm:w-1/2',
        controlLayout === 'full' && 'sm:w-full',
        controlLayout === 'standard' && 'sm:w-auto sm:shrink-0',
      )}>{children}</div>
    </div>
  )
}
