import { gatedFeatures, killSwitches, upcomingFeatures } from '@/lib/feature-flags'

export type DesktopFeatures = { flags: Record<string, boolean>; cloudComputer: boolean }
export type DesktopPublicConfiguration = { features: DesktopFeatures; daemonPackageName: string }
const publicFlags = [...Object.values(upcomingFeatures).map(feature => feature.key), ...Object.values(gatedFeatures), killSwitches.computerTab]
const defaults = (): DesktopPublicConfiguration => ({ features: { flags: Object.fromEntries(publicFlags.map(key => [key, false])), cloudComputer: false }, daemonPackageName: '@aspectlylabs/mikka' })
let configuration = defaults()
const listeners = new Set<() => void>()

/** The existing bootstrap carries a public, owner-evaluated snapshot. No
 * telemetry SDK, remote script, flag refresh request or timer runs here. */
export function setClientConfiguration(value?: Partial<DesktopPublicConfiguration> | null) {
  const next = defaults()
  for (const key of publicFlags) next.features.flags[key] = value?.features?.flags?.[key] === true
  next.features.cloudComputer = value?.features?.cloudComputer === true
  if (typeof value?.daemonPackageName === 'string') next.daemonPackageName = value.daemonPackageName
  if (configuration.daemonPackageName === next.daemonPackageName && configuration.features.cloudComputer === next.features.cloudComputer && publicFlags.every(key => configuration.features.flags[key] === next.features.flags[key])) return
  configuration = next
  for (const listener of listeners) listener()
}

export function getClientConfiguration() { return configuration }
export function subscribeClientConfiguration(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
