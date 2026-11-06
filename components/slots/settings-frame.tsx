'use client'

import { AppFrame, WindowBar } from '@/components/app-shell'
import { IconRail } from '@/components/nav/icon-rail'
import { SearchPill } from '@/components/nav/global-search'
import { BrowserToggle } from '@/components/browser/browser-toggle'
import type { SettingsFrameProps } from '@/components/slots/settings-frame-contract'

export function SettingsFrame({ onRail, onSearch, onBrowser, children, ...menu }: SettingsFrameProps) {
  return <AppFrame settings bar={<WindowBar center={<SearchPill onSearch={onSearch} />} trailing={<BrowserToggle open={false} onToggle={onBrowser} />} />} rail={<IconRail active={null} onNavigate={onRail} {...menu} />}>{children}</AppFrame>
}
