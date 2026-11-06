import { withDeviceRoute } from '@/lib/device-route'
import { authenticateDevice, ownedDeviceWithReport } from '@/lib/device-link'
import { subscriptionRuntime } from '@/lib/subscription-runtime'
import { leaseDevice } from '@/lib/subscription-native-device'
import { subscriptionNativeLease } from '@/lib/subscription-native-lease'

export const runtime = 'nodejs'
const handlePOST = subscriptionNativeLease({
  authorize: async (request, deviceId) => {
    const caller = await authenticateDevice(request)
    if (!caller || !leaseDevice(await ownedDeviceWithReport(deviceId, caller.userId), deviceId, caller.scopeDeviceId)) return null
    return caller.userId
  },
  service: () => subscriptionRuntime(true, false, { exportAccessLease: true }),
})

export const POST = withDeviceRoute(handlePOST)
