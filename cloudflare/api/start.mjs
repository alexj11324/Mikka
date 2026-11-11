import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function verifyImage(evidence, env) {
  const sha = /^[a-f0-9]{40}$/
  if (evidence.preset !== 'node-server' || !sha.test(env.MIKKA_BUILD_REVISION)
    || evidence.revision !== env.MIKKA_BUILD_REVISION || !sha.test(env.MIKKA_UI_OVERLAY_SHA)
    || evidence.overlaySha !== env.MIKKA_UI_OVERLAY_SHA || !env.MIKKA_DEPLOYMENT_ID
    || evidence.deploymentId !== env.MIKKA_DEPLOYMENT_ID) throw new Error('CLOUDFLARE_API_RELEASE_MISMATCH')
}

export function verifyBusinessWorld(evidence, bytes) {
  if (evidence.businessWorld?.path !== 'world-business.mjs'
      || createHash('sha256').update(bytes).digest('hex') !== evidence.businessWorld.sha256) {
    throw new Error('CLOUDFLARE_API_BUSINESS_WORLD_MISMATCH')
  }
}

function httpsOrigin(value) {
  if (!value || !URL.canParse(value)) return null
  const url = new URL(value)
  return url.protocol === 'https:' && url.origin === value && !url.hostname.includes('*') ? url.origin : null
}

export function verifyConfiguration(env) {
  if (env.NODE_ENV !== 'production' || env.MIKKA_EDITION !== 'cloud' || env.VERCEL || env.VERCEL_ENV) {
    throw new Error('CLOUDFLARE_API_EDITION_INVALID')
  }
  const origin = httpsOrigin(env.BETTER_AUTH_URL)
  const eve = httpsOrigin(env.MIKKA_EVE_ORIGIN)
  if (!origin || !eve || origin === eve) throw new Error('CLOUDFLARE_API_ORIGINS_INVALID')
  if (!env.BETTER_AUTH_SECRET || !env.DATABASE_URL || !env.MIKKA_DATABASE_URL) {
    throw new Error('CLOUDFLARE_API_CONFIGURATION_MISSING')
  }
  if (env.MIKKA_API_INGRESS === 'cloudflare' && (eve !== 'https://eve.internal'
      || env.WORKFLOW_TARGET_WORLD !== '/app/world-business.mjs' || !env.MIKKA_DEPLOYMENT_ID
      || !/^[A-Za-z0-9+/]{43}=$/.test(env.MIKKA_WORKFLOW_QUEUE_PUBLIC_KEY ?? '')
      || !/^[\da-f-]{72}$/.test(env.MIKKA_BUSINESS_WORLD_TOKEN ?? ''))) {
    throw new Error('CLOUDFLARE_API_PRIVATE_BINDINGS_REQUIRED')
  }
  const world = env.WORKFLOW_TARGET_WORLD?.trim()
  if (!world || ['local', 'vercel', '@workflow/world-local', '@workflow/world-vercel'].includes(world)) {
    throw new Error('CLOUDFLARE_API_HOSTED_WORLD_REQUIRED')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.version.startsWith('v24.')) throw new Error('CLOUDFLARE_API_NODE24_REQUIRED')
  const evidence = JSON.parse(await readFile('mikka-build.json', 'utf8'))
  verifyBusinessWorld(evidence, await readFile('world-business.mjs'))
  if (process.argv[2] === 'verify-image') {
    verifyImage(evidence, process.env)
  } else {
    verifyConfiguration(process.env)
    await import('./server/mikka-entry.mjs')
  }
}
