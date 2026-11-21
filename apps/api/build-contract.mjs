import { join, resolve } from 'node:path'

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
  // `@/…` resolves through the repository root alias, so the contract checks
  // that the root is wired and that the historical framework specifiers are
  // gone from the alias table — a leftover entry would silently shadow the
  // application's own modules. Both sides go through `resolve`: the real
  // callers derive `root` from a directory URL, which keeps a trailing slash,
  // while the alias table holds the same path without one. The key must be
  // present: `resolve('')` is the working directory, which would match `root`
  // whenever the build runs from the repository.
  const aliasRoot = options.alias?.['@']
  if (entry !== expected || typeof aliasRoot !== 'string' || resolve(aliasRoot) !== resolve(root)
    || Object.keys(options.alias ?? {}).some(key => key === 'next' || key.startsWith('next/'))
    || Object.keys(options.alias ?? {}).some(key => key.startsWith('next-intl'))
    || options.workflow?.dirs?.length !== productWorkflowDirectories.length
    || productWorkflowDirectories.some((directory, index) => options.workflow.dirs[index] !== directory)
    || !options.plugins?.includes(join(root, 'apps/api/plugins/security-headers.ts'))
    || !options.plugins?.includes(join(root, 'apps/api/plugins/workflow-world.ts'))
    || !options.externals?.external?.includes('pg')) throw new Error('API_CONFIG_NOT_LOADED')
}
