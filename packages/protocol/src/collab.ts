// The collaborative document channel (ORV-171): one WebSocket per open issue
// description, carrying Yjs updates and awareness between the members editing
// it. The wire format is y-websocket's, so the desktop side is y-websocket's
// own `WebsocketProvider` and the server side is the same y-protocols calls
// that provider expects — Orvilo defines no collaboration protocol of its own.
//
// The channel is a sibling of the relay (`/v1/stream`, ADR 0002), not part of
// it: the relay is keyed by run id and carries JSON frames, while a Yjs
// document needs binary frames and a lifetime of its own. It reuses the
// relay's handshake conventions (JWT in the query, client-version gate) so a
// client that is too old is refused the same way on both.
import { z } from "zod"

/** Where a document is opened: `/v1/collab/<issueId>`. */
export const COLLAB_PATH = "/v1/collab"
/** JWT for the handshake (a browser WebSocket cannot set headers). */
export const COLLAB_TOKEN_PARAM = "token"
/** The Yjs field a description lives in, as Tiptap's Collaboration expects. */
export const COLLAB_FIELD = "default"

/**
 * Close codes (4000-4999 are app-defined). y-websocket treats 4400-4499 as
 * permanent: the provider stops reconnecting, which is what an expired token
 * or a document this member may not open should do.
 */
export const COLLAB_CLOSE = {
  /** No usable token: reconnect with a fresh one. */
  unauthorized: 4401,
  /** The member may not read this issue (ADR 0047). */
  forbidden: 4403,
  /** No such issue in any workspace this token can see. */
  notFound: 4404,
  /** The client is older than the server's floor. */
  updateRequired: 4426,
} as const

/**
 * How long a document stays in memory after the last connection leaves. A
 * member who navigates away and back, or whose socket drops for a moment,
 * finds the document still there instead of reloading it from Postgres.
 */
export const COLLAB_IDLE_MS = 5 * 60_000
/** A save is written this long after the last edit. */
export const COLLAB_SAVE_DEBOUNCE_MS = 2_000
/** A description snapshot is appended at most this often (ADR 0070). */
export const COLLAB_SNAPSHOT_INTERVAL_MS = 60_000

/**
 * Cursor colours, one per member, chosen from the user id so the same member
 * keeps the same colour across reconnects and across the members looking at
 * the document. These are ephemeral presence values, never stored, which is
 * why they are raw colours and not the label keys the database holds.
 */
export const COLLAB_COLORS = [
  "#e5484d",
  "#f76b15",
  "#f5b800",
  "#30a46c",
  "#12a594",
  "#3e63dd",
  "#8e4ec6",
  "#d6409f",
] as const

/** The cursor colour for a member: stable, and spread across the palette. */
export function collabColorFor(userId: string): string {
  let hash = 0
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0
  }
  return COLLAB_COLORS[Math.abs(hash) % COLLAB_COLORS.length]!
}

/**
 * What a member publishes about themselves in the Yjs awareness state. The
 * server replaces it with the authenticated member's own name and colour, so a
 * client cannot label its cursor as somebody else.
 */
export const collabUser = z.object({
  name: z.string().min(1).max(120),
  color: z.string().min(1).max(32),
})
export type CollabUser = z.infer<typeof collabUser>
