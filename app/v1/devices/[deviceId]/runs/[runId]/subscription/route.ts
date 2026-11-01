import { withDeviceRoute } from '@/lib/device-route'
import { authenticateDevice, ownedDevice } from "@/lib/device-link";
import { subscriptionRuntime } from "@/lib/subscription-runtime";
import { subscriptionNativeHTTP } from "@/lib/subscription-native-http";
import { nativeProxyDevice } from "@/lib/subscription-native-device";

export const runtime = "nodejs";
export const maxDuration = 300;
const handlePOST = subscriptionNativeHTTP({
  authorize: async (request, deviceId) => {
    const caller = await authenticateDevice(request);
    if (!caller) return null;
    if (!nativeProxyDevice(await ownedDevice(deviceId, caller.userId), deviceId)) return null;
    return caller.userId;
  },
  service: () => subscriptionRuntime(true),
});

export const POST = withDeviceRoute(handlePOST)
