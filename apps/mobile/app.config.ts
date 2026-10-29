import type { ConfigContext, ExpoConfig } from 'expo/config'

/**
 * app.json plus what differs per build. `extra.eas.projectId` is the EAS
 * project the Expo push token is minted for (lib/push.ts): without it the
 * phone cannot register and Settings shows 「推送无法送达」. It comes from
 * EAS_PROJECT_ID (an EAS environment variable, or the shell for a local
 * build) rather than being written here, so forks build against their own
 * EAS project. See README "Push".
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  const projectId = process.env.EAS_PROJECT_ID ?? (config.extra?.eas as { projectId?: string } | undefined)?.projectId
  return {
    ...config,
    name: config.name ?? 'Mikka',
    slug: config.slug ?? 'mikka',
    extra: { ...config.extra, ...(projectId ? { eas: { ...(config.extra?.eas as object | undefined), projectId } } : {}) },
  }
}
