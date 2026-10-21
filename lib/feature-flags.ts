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
      ? '暂未开放：远端开关已开启，但此功能尚未实现。'
      : '暂未开放：此功能的 PostHog 开关已关闭或尚未加载。',
  }
}
