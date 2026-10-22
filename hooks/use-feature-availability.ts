'use client'

import { useCallback, useSyncExternalStore } from 'react'
import { useTranslations } from 'next-intl'
import posthog from 'posthog-js'
import { featureAvailability, upcomingFeatures, type UpcomingFeature } from '@/lib/feature-flags'

const subscribe = (notify: () => void) => posthog.onFeatureFlags(() => notify())
const serverSnapshot = () => undefined

export function useFeatureAvailability(feature: UpcomingFeature) {
  const t = useTranslations()
  const key = upcomingFeatures[feature].key
  const snapshot = useCallback(() => posthog.getFeatureFlag(key, { send_event: false }), [key])
  const value = useSyncExternalStore(subscribe, snapshot, serverSnapshot)
  const availability = featureAvailability(feature, value)
  return { ...availability, reason: t(availability.reason as never) }
}
