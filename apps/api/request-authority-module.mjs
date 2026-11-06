import { fileURLToPath } from 'node:url'

/** Match Workflow's resolved-preset check: a VERCEL environment variable alone
 * must not change the independent Node/Docker or local development ingress. */
export function vercelRequestAuthority(nitro) {
  if (nitro.options.dev || nitro.options.preset !== 'vercel') return
  const plugin = fileURLToPath(new URL('./plugins/request-authority.ts', import.meta.url))
  nitro.options.plugins ??= []
  // Later fetch wrappers (notably security-headers) still project their headers
  // onto rejected/legacy responses, while authority runs before the H3 router.
  if (!nitro.options.plugins.includes(plugin)) nitro.options.plugins.unshift(plugin)
}
