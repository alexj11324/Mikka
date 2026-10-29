import { withBasePath } from '@/lib/base-path'
import { UPLOADED_AVATAR_PATH } from '@/lib/account/avatar-file'

/** The default avatars in public/avatars (scripts/generate-default-avatars.py draws them). */
export const DEFAULT_AVATARS = ['blue', 'green', 'purple', 'orange', 'red'] as const

const STORED = /^\/avatars\/[a-z]+\.webp$/

/**
 * The avatar a new account gets when it signs up without one (email sign-up, or a
 * provider that sends no picture). It is stored on the user at sign-up, so accounts
 * made before this keep their initial: nothing is rewritten. Keyed by name, else email.
 */
export function newUserAvatar(key: string) {
  let hash = 0
  for (const char of key.trim().toLowerCase()) hash = (hash * 31 + char.codePointAt(0)!) | 0
  return `/avatars/${DEFAULT_AVATARS[Math.abs(hash) % DEFAULT_AVATARS.length]}.webp`
}

/**
 * Where to load a user's stored image from: a stored default avatar and an
 * uploaded picture (lib/account/avatar-file.ts) sit under the app's base path.
 */
export function avatarImageSrc(image: string | null | undefined) {
  if (!image) return undefined
  return STORED.test(image) || UPLOADED_AVATAR_PATH.test(image) ? withBasePath(image) : image
}
