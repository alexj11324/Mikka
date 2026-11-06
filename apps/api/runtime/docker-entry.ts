import '#nitro/virtual/polyfills'
import { useNitroApp, useNitroHooks } from 'nitro/app'
import { createDockerNodeRuntime } from './docker-node'

/** The same compiled app, routes, assets and Workflow plugins as node-server.
 * Only the attested public Docker harness owns the listening HTTP/WS server. */
export function createDockerRuntime({ origin }: { origin: string }) {
  return createDockerNodeRuntime(useNitroApp(), {
    origin,
    onClose: () => useNitroHooks().callHook('close'),
  })
}
