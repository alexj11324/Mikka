// `mikka daemon login`: OAuth 2.0 device authorization (RFC 8628) against
// the server's Better Auth device-authorization plugin, like `gh auth login`.
//
//   1. POST /api/auth/device/code   { client_id: "mikka-daemon" }
//   2. show the user code and the web verification link (including base path)
//   3. poll POST /api/auth/device/token every `interval` seconds until the
//      user approved (or denied, or the code expired)
//
// Mikka exchanges the temporary Better Auth session on the server. Only the
// resulting device token is returned and persisted by the daemon.
import {
  AUTH_BASE_PATH,
  CLIENT_VERSION_HEADER,
  DAEMON_CLIENT_ID,
} from "@mikka/protocol"
import { z } from "zod"

import { DaemonError, ServerUnreachableError } from "./errors"
import { DAEMON_VERSION } from "./paths"
import { serverUrl } from "./server-link-http"

export const DEVICE_CODE_PATH = `${AUTH_BASE_PATH}/device/code`
export const DEVICE_TOKEN_PATH = `${AUTH_BASE_PATH}/device/token`
export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code"

const deviceCodeResponse = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string(),
  verification_uri_complete: z.string().optional(),
  expires_in: z.number().positive(),
  interval: z.number().positive().default(5),
})
export type DeviceCode = z.infer<typeof deviceCodeResponse>

const tokenResponse = z.object({ access_token: z.string().regex(/^orv_[A-Za-z0-9_-]{43}$/) })
const errorResponse = z.object({ error: z.string() })

export class LoginError extends DaemonError {
  constructor(
    readonly reason: "access_denied" | "expired_token" | "failed",
    message: string
  ) {
    super(4003, message)
  }
}

export interface DeviceLoginOptions {
  serverUrl: string
  /** Shows the code and link to the user. */
  prompt: (code: DeviceCode) => void
  fetchImpl?: typeof fetch
  /** Injected in tests to skip real waiting. */
  sleep?: (ms: number) => Promise<void>
  signal?: AbortSignal
}

async function post(
  options: DeviceLoginOptions,
  path: string,
  body: unknown
): Promise<{ status: number; json: unknown }> {
  const fetchImpl = options.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(serverUrl(options.serverUrl, path), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CLIENT_VERSION_HEADER]: DAEMON_VERSION,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    })
  } catch (error) {
    throw new ServerUnreachableError(error)
  }
  return {
    status: response.status,
    json: await response.json().catch(() => null),
  }
}

/** Runs the device flow; resolves to a device token, never a web session. */
export async function deviceLogin(
  options: DeviceLoginOptions
): Promise<string> {
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const started = await post(options, DEVICE_CODE_PATH, {
    client_id: DAEMON_CLIENT_ID,
  })
  const code = deviceCodeResponse.safeParse(started.json)
  if (started.status !== 200 || !code.success)
    throw new LoginError(
      "failed",
      `The server did not start a device login (${started.status}).`
    )
  options.prompt(code.data)

  let intervalMs = code.data.interval * 1000
  const deadline = Date.now() + code.data.expires_in * 1000
  while (Date.now() < deadline) {
    await sleep(intervalMs)
    if (options.signal?.aborted)
      throw new LoginError("failed", "Login cancelled.")
    const polled = await post(options, DEVICE_TOKEN_PATH, {
      grant_type: DEVICE_GRANT_TYPE,
      device_code: code.data.device_code,
      client_id: DAEMON_CLIENT_ID,
    })
    const token = tokenResponse.safeParse(polled.json)
    if (polled.status === 200 && token.success) return token.data.access_token
    const error = errorResponse.safeParse(polled.json)
    switch (error.success ? error.data.error : "") {
      case "authorization_pending":
        continue
      case "slow_down":
        intervalMs += 5_000 // RFC 8628, section 3.5
        continue
      case "access_denied":
        throw new LoginError("access_denied", "The login was denied.")
      case "expired_token":
        throw new LoginError("expired_token", "The code expired; try again.")
      default:
        throw new LoginError(
          "failed",
          `Device login failed (${polled.status}${error.success ? `, ${error.data.error}` : ""}).`
        )
    }
  }
  throw new LoginError("expired_token", "The code expired; try again.")
}

/** Desktop SSH enrollment exchanges a one-use grant, never a browser session. */
export async function registrationLogin(options: { serverUrl: string; token: string; fetchImpl?: typeof fetch }): Promise<string> {
  if (!/^orv_[A-Za-z0-9_-]{43}$/.test(options.token)) throw new LoginError('failed', 'Invalid registration token.')
  const response = await (options.fetchImpl ?? fetch)(serverUrl(options.serverUrl, '/v1/devices/enroll'), {
    method: 'POST', headers: { authorization: `Bearer ${options.token}` }, redirect: 'error', signal: AbortSignal.timeout(30_000),
  })
  const body = await response.json().catch(() => null) as { credential?: unknown } | null
  const parsed = tokenResponse.safeParse({ access_token: body?.credential })
  if (!response.ok || !parsed.success) throw new LoginError('failed', 'Device registration token expired or already used.')
  return parsed.data.access_token
}
