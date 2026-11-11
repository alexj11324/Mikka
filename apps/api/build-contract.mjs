import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** pg and every tracing package must remain one real Node module instance so
 * the early bootstrap instruments both API and Workflow step queries. */
export const nodeRuntimePackages = [
  'pg', 'ai', 'drizzle-orm', 'officeparser', '@e965/xlsx', 'music-metadata', 'sharp',
  // Local World reads its adjacent package.json during real startup. Bundling
  // it loses that metadata and makes initDataDir reject the fallback 'bundled'.
  '@workflow/world-local',
  '@opentelemetry/api', '@opentelemetry/core', '@opentelemetry/exporter-trace-otlp-proto',
  '@opentelemetry/api-logs', '@opentelemetry/sdk-logs', '@opentelemetry/exporter-logs-otlp-proto',
  '@opentelemetry/instrumentation', '@opentelemetry/instrumentation-pg', '@opentelemetry/resources',
  '@opentelemetry/sdk-trace-base', '@opentelemetry/sdk-trace-node', '@opentelemetry/semantic-conventions',
]

export function workflowNodeExternals(nitro) {
  // @workflow/nitro 5.0.6 reads the old externals.external key even on Nitro3's
  // LocalBuilder branch. Rolldown's separate external list is not enough.
  nitro.options.externals = { ...(typeof nitro.options.externals === 'object' ? nitro.options.externals : {}),
    external: [...new Set([...(nitro.options.externals?.external ?? []), ...nodeRuntimePackages])] }
}

export function assertApiBuildConfiguration(nitro, root, { development = false } = {}) {
  const options = nitro.options
  const configured = options.routes?.['/**']
  const entry = typeof configured === 'string' ? configured : configured?.handler
  const expected = join(root, `apps/api/runtime/${development ? 'dev-entry' : 'entry'}.ts`)
  if (entry !== expected || options.alias?.['next/server'] !== join(root, 'apps/api/compat/server.ts')
    || options.alias?.['@/i18n/navigation'] !== join(root, 'apps/api/compat/localized-navigation.ts')
    || options.workflow?.dirs?.length !== 1 || options.workflow.dirs[0] !== '.'
    || !options.plugins?.includes(join(root, 'apps/api/plugins/security-headers.ts'))
    || !options.plugins?.includes(join(root, 'apps/api/plugins/workflow-world.ts'))
    || !options.externals?.external?.includes('pg')) throw new Error('API_CONFIG_NOT_LOADED')
}

export async function routeFunctionRules(root) {
  const manifest = JSON.parse(await readFile(join(root, 'apps/api/generated/routes.json'), 'utf8'))
  if (manifest.version !== 1 || manifest.basePath !== '/mikka' || !Array.isArray(manifest.routes)) throw new Error('API_ROUTE_MANIFEST_INVALID')
  const rules = {}, seen = new Set()
  for (const route of manifest.routes) {
    if (typeof route.path !== 'string' || route.path !== `/mikka${route.template}` || seen.has(route.path)
      || typeof route.source !== 'string' || route.source.startsWith('/') || route.source.split('/').includes('..')
      || !/^(?:app|apps\/api\/routes)\/.+\.ts$/.test(route.source)
      || !Array.isArray(route.methods) || !route.methods.length || route.methods.some(method => !['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'].includes(method))) throw new Error('API_ROUTE_MANIFEST_INVALID')
    seen.add(route.path)
    const hash = createHash('sha256').update(await readFile(join(root, route.source))).digest('hex')
    if (route.sourceHash !== hash) throw new Error('API_ROUTE_SOURCE_CHANGED')
    if (route.maxDuration === undefined) continue
    if (!Number.isInteger(route.maxDuration) || route.maxDuration < 1 || route.maxDuration > 800) throw new Error('API_ROUTE_DURATION_INVALID')
    // rou3 treats `*` as a catch-all and rejects more than one per route.
    // Named parameters retain each dynamic segment's original one-part bound.
    const pattern = route.path.replace(/\[\[?\.\.\.[^\]]+\]\]?/g, '**').replace(/\[([^\]]+)\]/g, ':$1')
    const supportsCancellation = route.template === '/api/coordinator/stream' || route.template === '/api/mcp' || route.template === '/api/agents/[...path]' || route.template === '/api/internal/eve/tools'
    rules[pattern] = { maxDuration: route.maxDuration, ...(supportsCancellation ? { supportsCancellation: true } : {}) }
  }
  return rules
}
