import type { Href } from 'expo-router'

/** What the account sheet holds (#1386 item 8), the same on iOS (SwiftUI Form) and the web build. */
export type AccountEntry = { href: Href; label: string; icon: 'tray' | 'checklist' | 'puzzlepiece.extension' | 'gearshape'; badge?: number }

export function accountEntries(suggestions: number | undefined): AccountEntry[][] {
  return [
    [
      { href: '/suggestions', label: '建议', icon: 'tray', badge: suggestions || undefined },
      { href: '/tasks', label: '任务', icon: 'checklist' },
      { href: '/plugins', label: '插件', icon: 'puzzlepiece.extension' },
    ],
    [{ href: '/settings', label: '设置', icon: 'gearshape' }],
  ]
}
