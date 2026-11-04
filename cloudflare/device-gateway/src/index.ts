import { handleRequest, type GatewayEnv } from './route'
import { DeviceSession } from './session'

export { DeviceSession }

export default {
  fetch(request: Request, env: GatewayEnv) {
    return handleRequest(request, env)
  },
}
