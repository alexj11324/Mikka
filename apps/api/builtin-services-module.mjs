import { fileURLToPath } from 'node:url'

/** Use the resolved preset, including build.mjs's node-server default. An env
 * variable alone must not change Vercel or the separate Vite development host. */
export function builtinServices(nitro) {
  if (nitro.options.dev || nitro.options.preset !== 'node-server') return
  const plugin = fileURLToPath(new URL('./plugins/builtin-services.ts', import.meta.url))
  const handler = fileURLToPath(new URL('./routes/builtin-gateway.ts', import.meta.url))
  nitro.options.features ??= {}
  nitro.options.features.websocket = true
  nitro.options.plugins ??= []
  if (!nitro.options.plugins.includes(plugin)) nitro.options.plugins.push(plugin)
  Object.assign(nitro.options.routes ??= {}, {
    '/mikka/v1/live/**': handler,
    '/mikka/v1/devices/:deviceId/socket': handler,
    '/mikka/v1/devices/:deviceId/push': handler,
    '/mikka/v1/devices/:deviceId/status': handler,
  })
}
