import { join } from 'node:path'

/** Main product World only; native Eve artifacts have an independent compiler. */
export const productWorkflowDirectories = ['workflows', 'lib']

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
    || options.workflow?.dirs?.length !== productWorkflowDirectories.length
    || productWorkflowDirectories.some((directory, index) => options.workflow.dirs[index] !== directory)
    || !options.plugins?.includes(join(root, 'apps/api/plugins/security-headers.ts'))
    || !options.plugins?.includes(join(root, 'apps/api/plugins/workflow-world.ts'))
    || !options.externals?.external?.includes('pg')) throw new Error('API_CONFIG_NOT_LOADED')
}
