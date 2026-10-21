'use client'

import { useState, type ComponentProps } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { isLocalSettingsNavigation, pushSettingsHistory } from '@/lib/settings-navigation'

export function SettingsLink({ workspaceId, href, onNavigate, ...props }: ComponentProps<typeof Link> & { workspaceId?: string }) {
  const pathname = usePathname()
  const params = useSearchParams()
  const [intent, setIntent] = useState(false)
  const local = typeof href === 'string' && isLocalSettingsNavigation(
    new URL(`${pathname}?${params}`, 'https://settings.invalid'),
    new URL(href, 'https://settings.invalid'),
    workspaceId,
  )
  return <Link {...props} href={href} prefetch={local ? false : props.prefetch ?? (intent ? true : null)} onPointerEnter={event => { if (!local) setIntent(true); props.onPointerEnter?.(event) }} onFocus={event => { if (!local) setIntent(true); props.onFocus?.(event) }} onNavigate={event => {
    if (onNavigate) { onNavigate(event); return }
    if (typeof href === 'string' && local) {
      event.preventDefault()
      pushSettingsHistory(href, workspaceId)
    }
  }} />
}
