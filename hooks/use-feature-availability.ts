'use client'

import { useCallback, useSyncExternalStore } from 'react'
import { useTranslations } from 'next-intl'
import posthog from 'posthog-js'
import { computerMock } from '@/lib/computer/client'
import { computerAcceptancePreview, computerProductionEnabled, featureAvailability, gatedFeatureEnabled, gatedFeatures, upcomingFeatures, type GatedFeature, type UpcomingFeature } from '@/lib/feature-flags'

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

/** The cloud computer UI uses the rollout flag or an explicit environment opt-in. */
export function useCloudComputer() {
  return useGatedFeature('cloudComputer') || computerMock || computerAcceptancePreview(process.env.NEXT_PUBLIC_COMPUTER_DEPLOYMENT, process.env.NEXT_PUBLIC_COMPUTER_ACCEPTANCE) || computerProductionEnabled(process.env.NEXT_PUBLIC_COMPUTER_DEPLOYMENT, process.env.NEXT_PUBLIC_COMPUTER_ENABLED)
}
