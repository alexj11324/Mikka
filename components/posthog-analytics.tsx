'use client'

import { useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'
import posthog from 'posthog-js'
import { authClient } from '@/lib/auth-client'
import { analyticsPath } from '@/lib/analytics-policy'

export function PostHogAnalytics() {
  const pathname = usePathname()
  const { data: session, isPending } = authClient.useSession()
  const userId = session?.user.id
  const previousIdentity = useRef<string | undefined>(undefined)
  const previousPage = useRef('')

  useEffect(() => {
    if (isPending) return
    if (previousIdentity.current && previousIdentity.current !== userId) {
      posthog.reset(true)
      posthog.register({ app: 'mikka', environment: process.env.NODE_ENV })
    }
    if (userId && posthog.get_distinct_id() !== userId) posthog.identify(userId)
    previousIdentity.current = userId
    if (!pathname) return
    const pageKey = `${userId ?? 'anonymous'}:${pathname}`
    if (previousPage.current === pageKey) return
    previousPage.current = pageKey
    posthog.capture('$pageview', { $current_url: `${window.location.origin}${analyticsPath(pathname)}` })
    posthog.reloadFeatureFlags()
  }, [pathname, userId, isPending])

  return null
}
