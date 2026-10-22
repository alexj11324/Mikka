// Client version gate (ADR 0011). Desktop sends its version on every REST
// request (header), on Zero (forwarded header) and on the relay handshake
// (query parameter). Below MIN_CLIENT_VERSION the server answers with the
// typed error below, which the app turns into an update prompt.
import { coerce, gte, valid } from "semver"
import { z } from "zod"

export const CLIENT_VERSION_HEADER = "x-mikka-client-version"
export const CLIENT_VERSION_PARAM = "client_version"

/**
 * Which version series the version above belongs to. The desktop (with the
 * daemon) and the phone release on their own schedules, so the server keeps a
 * minimum per series (MIN_CLIENT_VERSION / MIN_MOBILE_CLIENT_VERSION).
 */
export const CLIENT_KIND_HEADER = "x-mikka-client"
/** The relay handshake carries the same value as a query parameter. */
export const CLIENT_KIND_PARAM = "client_kind"

export const CLIENT_KINDS = ["desktop", "mobile"] as const
export const clientKind = z.enum(CLIENT_KINDS)
export type ClientKind = z.infer<typeof clientKind>

/**
 * A client that sends nothing — or something this version does not know — is
 * a desktop: every client older than the phone's sign-in is one, so the
 * default keeps the wire compatible (ADR 0011).
 */
export function clientKindOf(value: string | null | undefined): ClientKind {
  return value === "mobile" ? "mobile" : "desktop"
}

/** HTTP status for "update required" (426 Upgrade Required). */
export const UPDATE_REQUIRED_STATUS = 426

export const updateRequiredError = z.object({
  error: z.literal("update_required"),
  minVersion: z.string(),
  message: z.string(),
})
export type UpdateRequiredError = z.infer<typeof updateRequiredError>

export function isUpdateRequired(value: unknown): value is UpdateRequiredError {
  return updateRequiredError.safeParse(value).success
}

/**
 * True when `version` is valid semver at or above `minimum`. Pre-release and
 * build suffixes are ignored, so 1.0.0-beta.1 counts as 1.0.0.
 */
export function meetsMinimumVersion(
  version: string | null | undefined,
  minimum: string
): boolean {
  if (!valid(minimum)) throw new Error(`invalid minimum version: ${minimum}`)
  if (!version || !valid(version.trim())) return false
  return gte(coerce(version.trim()) ?? "0.0.0", minimum)
}

/**
 * Zero surfaces a non-OK status from the query/mutate endpoints as the
 * connection state `error` with the status in `reason`; 426 is our
 * "update required".
 */
export function isZeroUpdateRequired(reason: string | undefined): boolean {
  return (
    typeof reason === "string" &&
    new RegExp(`status ${UPDATE_REQUIRED_STATUS}\\b`).test(reason)
  )
}
