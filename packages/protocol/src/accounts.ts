// The signed-in person's connected accounts (ORV-26, Linear ORV-173): which
// external accounts they sign in with, and unlinking one.
//
// Better Auth keeps these in its `account` table next to the OAuth tokens
// (packages/db/src/schema/auth.ts). That table is deliberately not published
// to zero-cache (`account: false` in packages/zero-schema/drizzle-zero.config.ts),
// so the settings page reads it through the API server with the same
// short-lived JWT it hands zero-cache and the relay (ADR 0012), the way the
// avatar upload does. What crosses that boundary is spelled out below and
// nowhere else.
import { z } from "zod"

/** Where the desktop asks about, and changes, the caller's own accounts. */
export const ACCOUNT_ROUTES = {
  /** GET: the accounts linked to the caller. */
  list: "/v1/me/accounts",
  /** DELETE: unlink one, named by its provider ("github"). */
  unlink: "/v1/me/accounts/:providerId",
} as const

/**
 * One linked account, as the settings page shows it. This is the whole
 * contract: `accessToken`, `refreshToken`, `idToken`, `password` and the
 * expiry columns stay on the server, and the route selects exactly these
 * columns so a token cannot leak by adding a field to the row type.
 */
export const connectedAccount = z.object({
  /** The provider, e.g. "github". Unique per person, so it names the row. */
  providerId: z.string(),
  /**
   * The account's id at the provider. Better Auth stores the provider's own
   * user id here, which for GitHub is a number — the closest thing to a
   * display name the table holds.
   */
  accountId: z.string(),
  /** OAuth scopes granted, space separated. Null when the provider sent none. */
  scope: z.string().nullable(),
  /** When the account was linked, ISO 8601. */
  createdAt: z.string(),
})
export type ConnectedAccount = z.infer<typeof connectedAccount>

export const connectedAccountsResponse = z.object({
  accounts: z.array(connectedAccount),
})
export type ConnectedAccountsResponse = z.infer<
  typeof connectedAccountsResponse
>

/**
 * Why an unlink was refused. The server sends one of these as the `error`
 * field; the page turns it into a sentence, so the reason survives the wire
 * instead of being flattened into "something went wrong".
 */
export const ACCOUNT_UNLINK_REFUSALS = [
  /** No account of the caller's has that provider. */
  "not_found",
  /** It is the only way in; `emailAndPassword` is off, so unlinking locks them out. */
  "last_account",
] as const
export type AccountUnlinkRefusal = (typeof ACCOUNT_UNLINK_REFUSALS)[number]

/** True when a response body carries one of the refusal codes above. */
export function isAccountUnlinkRefusal(
  value: unknown
): value is AccountUnlinkRefusal {
  return (ACCOUNT_UNLINK_REFUSALS as readonly unknown[]).includes(value)
}
