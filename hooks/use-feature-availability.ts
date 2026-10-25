'use client'

import { useCallback, useSyncExternalStore } from 'react'
import { useTranslations } from 'next-intl'
import posthog from 'posthog-js'
import { computerMock } from '@/lib/computer/client'
import { featureAvailability, gatedFeatureEnabled, gatedFeatures, upcomingFeatures, type GatedFeature, type UpcomingFeature } from '@/lib/feature-flags'

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

export function useGatedFeature(feature: GatedFeature) {
  const key = gatedFeatures[feature]
  const snapshot = useCallback(() => posthog.getFeatureFlag(key, { send_event: false }), [key])
  return gatedFeatureEnabled(useSyncExternalStore(subscribe, snapshot, serverSnapshot))
}

/** The cloud computer UI, behind its PostHog flag; the mock (NEXT_PUBLIC_COMPUTER_MOCK=1) plays the backend, so it shows without it. */
export function useCloudComputer() {
  return useGatedFeature('cloudComputer') || computerMock
}
