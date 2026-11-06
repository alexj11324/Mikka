import { definePlugin } from 'nitro'
import { useNitroHooks } from 'nitro/app'
import { getWorld } from 'workflow/runtime'

export default definePlugin(async () => {
  if (process.env.WORKFLOW_TARGET_WORLD !== 'local') return
  const world = await getWorld()
  // Register before startup so an initialization failure can still close its
  // queue. Vercel's managed World keeps the SDK's normal platform lifecycle.
  useNitroHooks().hook('close', async () => { await world.close?.() })
  await world.start?.()
})
