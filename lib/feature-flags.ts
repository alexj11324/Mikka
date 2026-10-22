export const upcomingFeatures = {
  product: { key: 'orvilo-upcoming-product-features', implemented: false },
  integrations: { key: 'orvilo-upcoming-integrations', implemented: false },
  administration: { key: 'orvilo-upcoming-administration', implemented: false },
  teamSettings: { key: 'orvilo-upcoming-team-settings', implemented: false },
} satisfies Record<string, { key: string; implemented: boolean }>

export type UpcomingFeature = keyof typeof upcomingFeatures

export function featureAvailability(feature: UpcomingFeature, remoteValue: boolean | string | undefined) {
  const capability = upcomingFeatures[feature]
  return {
    enabled: capability.implemented && remoteValue === true,
    key: capability.key,
    reason: remoteValue === true && !capability.implemented
      ? 'FeatureCopy.c_7a3f5896'
      : 'FeatureCopy.c_3760dbb0',
  }
}
