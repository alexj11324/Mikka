import { definePlugin } from 'nitro'
import { useNitroHooks } from 'nitro/app'
import { startEveService } from '../../../scripts/eve-service.mjs'

export default definePlugin(async () => {
  const service = await startEveService()
  useNitroHooks().hook('close', service.close)
})
