// What the settings frame slot receives (docs/ui-overlay.md): the app's rail and
// window bar around the settings page. The default (components/slots/settings-frame.tsx)
// and a layer's slots/settings-frame.tsx both implement `SettingsFrame`; callers
// import from @/components/settings/settings-shell, except IssueWorkspace.
// Each may also export `OWN_SETTINGS_FRAME` (optional; see UI_SLOT_EXPORTS in
// lib/ui-overlay.mjs): true when settings must be drawn in this frame instead
// of inside the workspace's frame.
import type { ReactNode } from 'react'
import type { RailDestination } from '@/components/nav/icon-rail'

export type RailMenu = { user: { name: string; email: string; image?: string | null }; onSettings: (href?: string) => void; onSignOut: () => void; signingOut: boolean }

export type SettingsFrameProps = RailMenu & { onRail: (destination: RailDestination) => void; onSearch: () => void; onBrowser: () => void; children: ReactNode }
