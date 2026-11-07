import { CodedError } from '@mikka/protocol/coded-error'

export type MikkaEdition = 'community' | 'cloud'

/** The deployment edition is runtime configuration, never a browser build flag. */
export function getEdition(env: Readonly<Record<string, string | undefined>> = process.env): MikkaEdition {
  const value = env.MIKKA_EDITION?.trim() || 'community'
  if (value === 'community' || value === 'cloud') return value
  throw new CodedError('MIKKA_EDITION_INVALID', { detail: 'expected_community_or_cloud' })
}

export function isCloudEdition(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return getEdition(env) === 'cloud'
}
