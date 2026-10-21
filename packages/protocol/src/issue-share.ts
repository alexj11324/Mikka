// Sharing one issue with somebody outside the workspace (ADR ORV-70). The token
// is the whole secret: the renderer generates it, shows it once, and only its
// sha256 is ever written down, so the server cannot replay a stored row.

/** What somebody holding a share link may do with the issue. */
export const ISSUE_SHARE_PERMISSIONS = ["read", "comment"] as const
export type IssueSharePermission = (typeof ISSUE_SHARE_PERMISSIONS)[number]

/** 32 bytes of randomness, base64url, unpadded: 43 characters. */
export const SHARE_TOKEN_BYTES = 32
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

/** Where a share link lives on the API server; it takes no other prefix. */
export const ISSUE_SHARE_PATH = "/share"

/** sha256 as lowercase hex, which is what `token_hash` holds. */
const SHARE_TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/

/** A fresh share token. It never leaves the machine that created the share. */
export function createShareToken(): string {
  const bytes = new Uint8Array(SHARE_TOKEN_BYTES)
  crypto.getRandomValues(bytes)
  return toBase64Url(bytes)
}

/** True when a string is shaped like a token this app generated. */
export function isShareToken(value: string): boolean {
  return SHARE_TOKEN_PATTERN.test(value)
}

/** True when a string could be a `token_hash` column value. */
export function isShareTokenHash(value: string): boolean {
  return SHARE_TOKEN_HASH_PATTERN.test(value)
}

/**
 * The stored value for a token. WebCrypto, so the renderer that creates a
 * share and the server that checks one derive the same hash from the same
 * implementation.
 */
export async function hashShareToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  )
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

/** The link a person copies; `base` is the server's public URL. */
export function issueShareUrl(base: string, token: string): string {
  return `${base.replace(/\/+$/, "")}${ISSUE_SHARE_PATH}/${token}`
}

/**
 * A mention inside comment text, the same syntax the app renders as a chip
 * (`packages/zero-schema/src/notifications.ts`, `renderer/lib/model.ts`).
 */
const MENTION_SYNTAX = /@\[([^\]\n]+)\]\(user:[0-9a-fA-F-]{36}\)/g

/**
 * Text with mention syntax flattened to plain `@Name`. Both directions of a
 * share go through it: somebody outside the workspace cannot name a member —
 * they do not know who is in it — so what they write is flattened before the
 * row is stored, and what they read is flattened before the page is rendered,
 * which is what keeps a member id off a public page (ADR ORV-70).
 */
export function stripMentions(text: string): string {
  return text.replace(MENTION_SYNTAX, (_match, name: string) => `@${name}`)
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
