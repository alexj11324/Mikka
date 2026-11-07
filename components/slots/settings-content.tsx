'use client'

import { AppShellContent } from '@/components/app-shell'
import type { SettingsContentFrameProps } from '@/components/slots/settings-content-contract'

/** The heading and card around a settings section's body. */
export function SettingsContentFrame({ parent, title, children }: SettingsContentFrameProps) {
  return <AppShellContent parent={parent} title={title} variant="settings">{children}</AppShellContent>
}
