// Shared decoding helpers for vendor quota payloads. A value that looks like
// a credential is dropped instead of copied into a plan or model name.

const SECRET_SHAPE =
  /bearer\s|sk-ant-|sk-[a-z0-9_-]{8,}|eyJ[a-z0-9_-]{8,}|ya29\.|gh[opusr]_/i

/** Vendor percentages are 0..100. Returns a 0..1 fraction, or null. */
export function percentPoints(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return null
  return Math.min(1, value / 100)
}

export function ratio(used: unknown, limit: unknown): number | null {
  if (typeof used !== "number" || typeof limit !== "number") return null
  if (!Number.isFinite(used) || !Number.isFinite(limit)) return null
  if (used < 0 || limit <= 0) return null
  return Math.min(1, used / limit)
}

export function isoString(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return null
  return new Date(parsed).toISOString()
}

/** Codex `reset_at` is unix seconds. */
export function isoUnixSeconds(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  const ms = value * 1000
  if (ms < Date.UTC(2020, 0, 1) || ms > Date.UTC(2100, 0, 1)) return null
  return new Date(ms).toISOString()
}

export function cleanText(value: unknown, max = 40): string | null {
  if (typeof value !== "string") return null
  if (SECRET_SHAPE.test(value)) return null
  const cleaned = value
    .replace(/[^\p{L}\p{N} .+_-]/gu, "")
    .trim()
    .slice(0, max)
  return cleaned.length > 0 ? cleaned : null
}

export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error("Credential file is not valid JSON")
  }
}

export const QUOTA_REQUEST_TIMEOUT_MS = 15_000

export function quotaSignal(parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(QUOTA_REQUEST_TIMEOUT_MS)
  if (!parent) return timeout
  return AbortSignal.any([parent, timeout])
}

/**
 * One GET that does not follow redirects. A redirect would be a place for
 * the Authorization header or session cookie to leave the vendor host.
 * The body is read only on success, and a JSON error becomes null rather
 * than an exception that quotes the payload.
 */
export async function quotaGet(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  signal?: AbortSignal
): Promise<{ status: number; body: unknown | null }> {
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "error",
    signal: quotaSignal(signal),
    headers,
  })
  if (!response.ok) return { status: response.status, body: null }
  const length = Number(response.headers.get("content-length"))
  if (Number.isFinite(length) && length > 1_000_000) {
    return { status: response.status, body: null }
  }
  try {
    return { status: response.status, body: await response.json() }
  } catch {
    return { status: response.status, body: null }
  }
}
