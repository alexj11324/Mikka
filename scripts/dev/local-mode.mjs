// Development-mode local substitutes for cloud services (docs/dev-workflow.md § 12).
// The switch is the shared local test-account mode: MIKKA_LOCAL_TEST_ACCOUNTS=1
// with every application database on a loopback *_e2e target. Nothing here is
// reachable from a deployment: Vercel and NODE_ENV=production are refused.
import { localTestAccountsMode } from '../test-accounts/database-target.mjs'

export const LOCAL_SERVICES_PORT = 3192
export const LOCAL_GATEWAY_KEY = 'mikka-local-gateway'
export const LOCAL_RESEND_KEY = 'mikka-local-outbox'
export const LOCAL_CRON_SECRET = 'mikka-local-cron'

/** True only in local test-account mode, off Vercel, outside production, and not opted out. */
export function localServicesEnabled(env = process.env) {
  if (env.VERCEL || env.VERCEL_ENV || env.NODE_ENV === 'production') return false
  if (env.MIKKA_LOCAL_SERVICES === '0') return false
  return localTestAccountsMode(env)
}

export function localServicesOrigin(env = process.env) {
  const port = Number(env.MIKKA_LOCAL_SERVICES_PORT || LOCAL_SERVICES_PORT)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('MIKKA_LOCAL_SERVICES_PORT must be a port number from 1024 to 65535')
  return `http://127.0.0.1:${port}`
}

/**
 * Variables for the Next child process only. They are public placeholders,
 * never credentials: the preload sends every request that carries them to the
 * loopback services. The developer's shell keeps none of them, so the
 * test-account harness (which refuses provider keys) is unaffected.
 */
export function localServicesChildEnv(env = process.env, preloadPath) {
  const origin = localServicesOrigin(env)
  const importFlag = `--import=${preloadPath}`
  return {
    MIKKA_LOCAL_SERVICES_ORIGIN: origin,
    AI_GATEWAY_API_KEY: LOCAL_GATEWAY_KEY,
    RESEND_API_KEY: LOCAL_RESEND_KEY,
    NODE_OPTIONS: [env.NODE_OPTIONS, importFlag].filter(Boolean).join(' '),
  }
}
