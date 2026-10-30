// No Node imports: lib/default-avatar.ts (client components) reads UPLOADED_AVATAR_PATH.

/**
 * Uploaded profile pictures. The client shrinks the picture to at most 256 px
 * before sending it, so 200 KB is generous for PNG/JPEG/WebP at that size and
 * still keeps one avatar small enough to serve straight from a database row
 * when no bucket is configured.
 */
export const AVATAR_MAX_BYTES = 200 * 1024
export const AVATAR_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type AvatarContentType = (typeof AVATAR_CONTENT_TYPES)[number]

export const AVATAR_EXTENSIONS: Record<AvatarContentType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

/** `/api/avatars/<userId>/<sha256>`: content-addressed, so a new picture is a new URL. */
export const UPLOADED_AVATAR_PATH = /^\/api\/avatars\/[A-Za-z0-9_-]{1,128}\/[a-f0-9]{64}$/

export function avatarPath(userId: string, sha256: string): string {
  return `/api/avatars/${userId}/${sha256}`
}

/**
 * The image type the bytes really are, from their signature. The declared
 * type is not trusted: SVG and anything else that could run script is never
 * accepted, whatever the browser said.
 */
export function sniffAvatarType(bytes: Uint8Array): AvatarContentType | null {
  const starts = (...signature: number[]) => signature.every((value, index) => bytes[index] === value)
  if (bytes.length >= 8 && starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (bytes.length >= 3 && starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (bytes.length >= 12 && starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return null
}

export type AvatarCheck =
  | { ok: true; contentType: AvatarContentType; bytes: Uint8Array }
  | { ok: false; reason: 'type' | 'size' }

/** Checks an uploaded file: one of the three image types (declared and actual agree) and at most 200 KB. */
export function checkAvatarFile(declaredType: string, bytes: Uint8Array): AvatarCheck {
  if (!(AVATAR_CONTENT_TYPES as readonly string[]).includes(declaredType)) return { ok: false, reason: 'type' }
  if (bytes.length === 0) return { ok: false, reason: 'type' }
  if (bytes.length > AVATAR_MAX_BYTES) return { ok: false, reason: 'size' }
  const actual = sniffAvatarType(bytes)
  if (!actual || actual !== declaredType) return { ok: false, reason: 'type' }
  return { ok: true, contentType: actual, bytes }
}
