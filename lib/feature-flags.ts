export const upcomingFeatures = {
  product: { key: 'mikka-upcoming-product-features', implemented: false },
  integrations: { key: 'mikka-upcoming-integrations', implemented: false },
  administration: { key: 'mikka-upcoming-administration', implemented: false },
  teamSettings: { key: 'mikka-upcoming-team-settings', implemented: false },
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

/** Built features held back by a PostHog flag until what they depend on is live. */
export const gatedFeatures = {
  /** The bots' cloud computer UI (#174); off until the E2B backend (#172) is live. */
  cloudComputer: 'mikka-cloud-computer',
} as const

export type GatedFeature = keyof typeof gatedFeatures

/** On only when PostHog says exactly true; unloaded, missing or multivariate values stay off. */
export function gatedFeatureEnabled(remoteValue: boolean | string | undefined) {
  return remoteValue === true
}
