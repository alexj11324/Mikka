// What the settings content slot receives (docs/ui-overlay.md): the heading
// and card around one settings section's body.
import type { ReactNode } from 'react'

export type SettingsContentFrameProps = { parent: string; title: string; children: ReactNode }
