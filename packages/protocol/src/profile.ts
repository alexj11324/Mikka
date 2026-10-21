// What a person may change about themselves in Settings › Profile (ORV-31).
// Shared so the form and the mutator validate identically: the mutator is the
// authority, the form is the courtesy. Like `skill.ts`, this holds the field
// schemas; the mutator's argument object lives in packages/zero-schema.
import { z } from "zod"

/**
 * The handle shown next to a person's name. Lowercase only, so the unique
 * index on `user.username` is case-insensitive in practice without a
 * functional index.
 */
export const usernameSchema = z
  .string()
  .trim()
  .min(3, "At least 3 characters.")
  .max(32, "At most 32 characters.")
  .regex(
    /^[a-z0-9][a-z0-9_-]*$/,
    "Start with a letter or digit; lowercase letters, digits, - and _ only."
  )

/** The name shown in issues, comments and the member list. */
export const displayNameSchema = z
  .string()
  .trim()
  .min(1, "A name is required.")
  .max(80, "At most 80 characters.")

/**
 * Where an avatar image lives: the object storage URL an upload produced, or
 * the URL a sign-in provider handed us. Never a `data:` URL — those would go
 * into every synced row.
 */
export const avatarUrlSchema = z
  .url()
  .max(2048)
  .refine((value) => /^https?:\/\//.test(value), "Use an http(s) URL.")

/** Largest avatar the server will sign an upload for. */
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024

export const AVATAR_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const
export type AvatarContentType = (typeof AVATAR_CONTENT_TYPES)[number]

/**
 * The desktop asks for a signed upload before it sends any bytes, so an
 * unsupported type or an oversized file is refused before it leaves the
 * machine. The client PUTs the file to `uploadUrl` itself.
 */
export const avatarPresignRequest = z.object({
  contentType: z.enum(AVATAR_CONTENT_TYPES),
  /** Bytes, checked against AVATAR_MAX_BYTES. */
  size: z.number().int().positive(),
})
export type AvatarPresignRequest = z.infer<typeof avatarPresignRequest>

export const avatarPresignResponse = z.object({
  uploadUrl: z.url(),
  /** What to store in `user.image` once the PUT has succeeded. */
  publicUrl: avatarUrlSchema,
  expiresIn: z.number().int().positive(),
})
export type AvatarPresignResponse = z.infer<typeof avatarPresignResponse>

/** Where the desktop asks for the signature. */
export const AVATAR_PRESIGN_ROUTE = "/v1/me/avatar"
