// The default bot-overview slot (docs/ui-overlay.md): none. The chat's 概览 keeps the community body in
// components/nav/context-panel.tsx; a layer that draws it exports a component here.
import type { ComponentType } from 'react'
import type { BotOverviewProps } from './bot-overview-contract'

export const BotOverview: ComponentType<BotOverviewProps> | null = null
