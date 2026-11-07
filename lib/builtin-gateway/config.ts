import { createHmac } from 'node:crypto'
import { isCloudEdition } from '../edition'

type Environment = Readonly<Record<string, string | undefined>>
export type GatewayConfig = { url: string; secret: string; mode: 'worker' | 'builtin' }

/** Explicit Worker configuration always wins. An incomplete override must not
 * silently send its traffic to a different gateway. */
export function gatewayConfig(env: Environment = process.env): GatewayConfig | null {
  if (env.DEVICE_GATEWAY_URL) {
    if (!env.DEVICE_GATEWAY_PUSH_SECRET) return null
    try {
      const url = new URL(env.DEVICE_GATEWAY_URL)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
      return { url: url.origin, secret: env.DEVICE_GATEWAY_PUSH_SECRET, mode: 'worker' }
    } catch { return null }
  }
  if (isCloudEdition(env) || env.VERCEL || !env.BETTER_AUTH_URL || !env.BETTER_AUTH_SECRET) return null
  try {
    const url = new URL(env.BETTER_AUTH_URL)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    // BETTER_AUTH_URL is the canonical origin. The current frontend/API build
    // mounts at /mikka; a configured path must never duplicate that mount.
    return { url: `${url.origin}/mikka`, mode: 'builtin',
      secret: env.DEVICE_GATEWAY_PUSH_SECRET || createHmac('sha256', env.BETTER_AUTH_SECRET).update('mikka:builtin-gateway:v1').digest('hex') }
  } catch { return null }
}

export function gatewayURL(config: Pick<GatewayConfig, 'url'>, path: string) {
  return new URL(`${config.url}${path}`)
}

export function builtinGatewayConfig(env: Environment = process.env) {
  const config = gatewayConfig(env)
  return config?.mode === 'builtin' ? config : null
}
