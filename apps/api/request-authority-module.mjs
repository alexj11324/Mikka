import { fileURLToPath } from 'node:url'

export function nodeRequestAuthority(nitro) {
  if (nitro.options.dev || nitro.options.preset !== 'node-server') return
  const plugin = fileURLToPath(new URL('./plugins/node-request-authority.ts', import.meta.url))
  nitro.options.plugins ??= []
  if (!nitro.options.plugins.includes(plugin)) nitro.options.plugins.unshift(plugin)
}
