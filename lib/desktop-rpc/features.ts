import 'server-only'
import { computerAcceptancePreview, computerProductionEnabled, gatedFeatures, killSwitches, upcomingFeatures } from '@/lib/feature-flags'
import { serverFlagEnabled } from '@/lib/posthog-server'
import type { DesktopFeatures } from './wire'

// These are the same public flags read by use-feature-availability. Never send
// arbitrary PostHog flags, project configuration or server environment values.
const publicKeys = [...Object.values(upcomingFeatures).map(feature => feature.key), ...Object.values(gatedFeatures), killSwitches.computerTab]

/** A bootstrap snapshot, using the web's user identity and strict-true rules. */
export async function desktopFeatures(userId?: string, {
  evaluate = serverFlagEnabled,
  env = process.env,
}: {
  evaluate?: (key: string, userId: string) => Promise<boolean>
  env?: Readonly<Record<string, string | undefined>>
} = {}): Promise<DesktopFeatures> {
  const flags = Object.fromEntries(await Promise.all(publicKeys.map(async key => [key, userId ? await evaluate(key, userId) : false])))
  return {
    flags,
    cloudComputer: flags[gatedFeatures.cloudComputer]
      || env.NEXT_PUBLIC_COMPUTER_MOCK === '1'
      || computerAcceptancePreview(env.NEXT_PUBLIC_COMPUTER_DEPLOYMENT, env.NEXT_PUBLIC_COMPUTER_ACCEPTANCE)
      || computerProductionEnabled(env.NEXT_PUBLIC_COMPUTER_DEPLOYMENT, env.NEXT_PUBLIC_COMPUTER_ENABLED),
  }
}
