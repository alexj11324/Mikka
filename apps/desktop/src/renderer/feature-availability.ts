import { useSyncExternalStore } from 'react'
import { useTranslations } from 'next-intl'
import { featureAvailability, gatedFeatureEnabled, gatedFeatures, killSwitches, upcomingFeatures, type GatedFeature, type UpcomingFeature } from '@/lib/feature-flags'
import { getClientConfiguration, subscribeClientConfiguration } from './client-configuration'

function useFeatures() {
  return useSyncExternalStore(subscribeClientConfiguration, getClientConfiguration, getClientConfiguration).features
}

export function useFeatureAvailability(feature: UpcomingFeature) {
  const t = useTranslations()
  const availability = featureAvailability(feature, useFeatures().flags[upcomingFeatures[feature].key])
  return { ...availability, reason: t(availability.reason as never) }
}

export function useGatedFeature(feature: GatedFeature) {
  return gatedFeatureEnabled(useFeatures().flags[gatedFeatures[feature]])
}

export function useCloudComputer() { return useFeatures().cloudComputer }
export function useComputerTab() { return useFeatures().flags[killSwitches.computerTab] !== true }
