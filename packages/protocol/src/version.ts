// Client version gate (ADR 0011). Desktop sends its version on every REST
// request (header), on Zero (forwarded header) and on the relay handshake
// (query parameter). Below MIN_CLIENT_VERSION the server answers with the
// typed error below, which the app turns into an update prompt.
import { coerce, gte, valid } from "semver"
import { z } from "zod"

export const CLIENT_VERSION_HEADER = "x-mikka-client-version"
export const CLIENT_VERSION_PARAM = "client_version"

/** Hosted wire compatibility is independent of app/store versions (an iOS OTA
 * does not change its native version). Floor zero admits released clients that
 * predate this header. Raise it only after every client has shipped the reader
 * for the next shape; see decision 2026-11-20-1300. */
export const HOSTED_API_VERSION = 1
export const HOSTED_API_FLOOR = 0
export const HOSTED_API_VERSION_HEADER = 'x-mikka-api-version'
export const HOSTED_API_HEADERS = { [HOSTED_API_VERSION_HEADER]: String(HOSTED_API_VERSION) } as const

/**
 * Which version series the version above belongs to. The desktop (with the
 * daemon) and the phone release on their own schedules, so the server keeps a
 * minimum per series (MIN_CLIENT_VERSION / MIN_MOBILE_CLIENT_VERSION).
 */
export const CLIENT_KIND_HEADER = "x-mikka-client"
const LEGACY_MOBILE_KIND_HEADER = 'x-mikka-client-kind'
const INSTALLED_CLIENT_KINDS = new Set(['desktop', 'mobile', 'daemon', 'cli'])
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

const hostedUpgrade = updateRequiredError.extend({
  minApiVersion: z.number().int().nonnegative(),
  cause: z.object({
    code: z.enum(['api_version_missing', 'api_version_invalid', 'api_version_below_floor']),
    version: z.number().int().nonnegative().nullable(),
    minimum: z.number().int().nonnegative(),
  }),
})
export type HostedApiUpgrade = z.infer<typeof hostedUpgrade>

/** Retain only public, typed cause data from an upgrade refusal. */
export function hostedApiUpgrade(value: unknown): HostedApiUpgrade | null {
  return hostedUpgrade.safeParse(value).data ?? null
}

/** Headers identify a compatibility contract, never an authenticated actor.
 * Ordinary browser/API integrations keep their existing unversioned contract.
 * Legacy mobile telemetry identifies the installed app until it sends the
 * shared client header; legacy daemons already send CLIENT_VERSION_HEADER. */
export function hostedApiUpgradeRequired(headers: Headers, minimum = HOSTED_API_FLOOR): HostedApiUpgrade | null {
  if (!Number.isSafeInteger(minimum) || minimum < 0) throw new RangeError('Invalid hosted API floor')
  const value = headers.get(HOSTED_API_VERSION_HEADER)
  const installed = value !== null || headers.has(CLIENT_VERSION_HEADER)
    || INSTALLED_CLIENT_KINDS.has(headers.get(CLIENT_KIND_HEADER) ?? '')
    || headers.get(LEGACY_MOBILE_KIND_HEADER) === 'mobile'
  if (!installed) return null
  const parsed = value === null ? 0 : /^(0|[1-9]\d*)$/.test(value) ? Number(value) : NaN
  const version = Number.isSafeInteger(parsed) ? parsed : null
  if (version !== null && version >= minimum) return null
  return {
    error: 'update_required', minVersion: String(minimum), minApiVersion: minimum,
    message: 'Update Mikka before continuing.',
    cause: { code: value === null ? 'api_version_missing' : version === null ? 'api_version_invalid' : 'api_version_below_floor', version, minimum },
  }
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
