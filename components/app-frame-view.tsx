'use client'

import { useTranslations } from 'next-intl'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'

/** Settings' own palette, mapped onto the shared tokens for everything inside the frame. */
export const SETTINGS_COLORS = '[--background:var(--settings-background)] [--foreground:var(--settings-foreground)] [--card:var(--settings-card)] [--card-foreground:var(--settings-foreground)] [--sidebar:var(--settings-sidebar)] [--sidebar-foreground:var(--settings-sidebar-foreground)] [--sidebar-accent:var(--settings-sidebar-accent)] [--sidebar-accent-foreground:var(--settings-foreground)] [--sidebar-border:var(--settings-border)] [--border:var(--settings-border)] [--input:var(--settings-input)] [--muted-foreground:var(--settings-muted-foreground)]'

/**
 * The app window, built like Comma's shell: one gray frame that never scrolls,
 * the window bar across the top, the rail on the left, and every page inside a
 * single rounded card. Columns inside the card scroll on their own.
 */
export function AppFrameView({ bar, rail, children, settings = false }: { bar: ReactNode; rail: ReactNode; children: ReactNode; settings?: boolean }) {
  const t = useTranslations('Shell')
  return <TooltipProvider><SidebarProvider className={cn('h-screen min-h-0 supports-[height:100dvh]:h-dvh flex-col overflow-hidden bg-shell-chrome in-data-desktop-translucent:bg-transparent', settings && SETTINGS_COLORS)}>
    {bar}
    <div className="flex min-h-0 flex-1 md:pr-2 md:pb-2">
      {rail}
      <section data-slot="app-frame-content" aria-label={t('window')} className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background in-data-desktop-translucent:bg-transparent md:rounded-xl md:shadow-xs md:ring-1 md:ring-border">{children}</section>
    </div>
  </SidebarProvider></TooltipProvider>
}

