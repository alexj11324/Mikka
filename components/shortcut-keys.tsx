'use client'

import { useSyncExternalStore, type ComponentProps } from 'react'
import { Kbd, KbdGroup } from '@/components/ui/kbd'

const subscribeToPlatform = () => () => {}
const serverPlatform = () => false
const APPLE_KEYS: Record<string, string> = { mod: '⌘', alt: '⌥', shift: '⇧' }
const OTHER_KEYS: Record<string, string> = { mod: 'Ctrl', alt: 'Alt', shift: 'Shift' }

function isApplePlatform() {
  const client = navigator as Navigator & { userAgentData?: { platform?: string } }
  const platform = client.userAgentData?.platform || client.platform || client.userAgent
  return /Mac|iPhone|iPad|iPod/i.test(platform)
}

export function useIsApplePlatform() {
  return useSyncExternalStore(subscribeToPlatform, isApplePlatform, serverPlatform)
}

export function useShortcutLabel(keys: readonly string[]) {
  const apple = useIsApplePlatform()
  const names = apple ? APPLE_KEYS : OTHER_KEYS
  return keys.map(key => names[key] ?? key).join(apple ? '' : '+')
}

export function ShortcutKeys({ keys, ...props }: ComponentProps<typeof KbdGroup> & { keys: readonly string[] }) {
  const apple = useIsApplePlatform()
  const names = apple ? APPLE_KEYS : OTHER_KEYS
  return <KbdGroup {...props}>{keys.map((key, index) => <Kbd key={`${key}-${index}`} aria-label={key === 'mod' ? apple ? 'Command' : 'Control' : undefined}>{names[key] ?? key}</Kbd>)}</KbdGroup>
}
