import type { DeploymentMode } from './policy'

/** Deployment identity, independent of billing setup and user-supplied headers. */
export function deploymentMode(env: Readonly<Record<string, string | undefined>> = process.env): DeploymentMode {
  if (env.MIKKA_EDITION === 'cloud') return 'cloud'
  if (env.MIKKA_EDITION === 'community') return 'selfhost'
  if (env.MIKKA_EDITION !== undefined && env.MIKKA_EDITION !== '') throw new Error('governance_invalid_edition')
  return env.VERCEL_ENV === 'production' || env.VERCEL_ENV === 'preview' ? 'cloud' : 'selfhost'
}
