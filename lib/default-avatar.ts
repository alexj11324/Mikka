import { withBasePath } from '@/lib/base-path'

/** The default avatars in public/avatars (scripts/generate-default-avatars.py draws them). */
export const DEFAULT_AVATARS = ['blue', 'green', 'purple', 'orange', 'red'] as const

/**
 * A person's avatar when they have no photo of their own. Keyed by the name people see
 * (their email when they have none), so the same person gets the same color everywhere.
 */
export function defaultAvatarSrc(key: string) {
  let hash = 0
  for (const char of key.trim().toLowerCase()) hash = (hash * 31 + char.codePointAt(0)!) | 0
  return withBasePath(`/avatars/${DEFAULT_AVATARS[Math.abs(hash) % DEFAULT_AVATARS.length]}.webp`)
}
