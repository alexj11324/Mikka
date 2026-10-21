'use client'

import { useCallback, useSyncExternalStore } from 'react'
import posthog from 'posthog-js'
import { featureAvailability, upcomingFeatures, type UpcomingFeature } from '@/lib/feature-flags'

const subscribe = (notify: () => void) => posthog.onFeatureFlags(() => notify())
const serverSnapshot = () => undefined

export function useFeatureAvailability(feature: UpcomingFeature) {
  const key = upcomingFeatures[feature].key
  const snapshot = useCallback(() => posthog.getFeatureFlag(key, { send_event: false }), [key])
  const value = useSyncExternalStore(subscribe, snapshot, serverSnapshot)
  return featureAvailability(feature, value)
}
