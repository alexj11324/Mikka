import type { ReactNode } from 'react'

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
        <div data-settings-rows className="divide-y">{children}</div>
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
  children,
}: {
  title: string
  description?: string
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm leading-snug font-medium text-foreground">{title}</span>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      <div className="shrink-0 text-sm">{children}</div>
    </div>
  )
}
