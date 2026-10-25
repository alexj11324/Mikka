import { authenticateDevice, ownedDevice, withDeviceAuthorization } from "@/lib/device-link";
import { subscriptionRuntime } from "@/lib/subscription-runtime";
import { subscriptionNativeHTTP } from "@/lib/subscription-native-http";

export const runtime = "nodejs";
export const maxDuration = 300;
const handlePOST = subscriptionNativeHTTP({
  authorize: async (request, deviceId) => {
    const caller = await authenticateDevice(request);
    if (
      !caller ||
      !(process.env.MIKKA_BYOS_HOSTED_DEVICE_IDS ?? "")
        .split(",")
        .includes(deviceId)
    )
      return null;
    const device = await ownedDevice(deviceId, caller.userId);
    if (!device?.enabled || !device.harnesses.some((h) => h.subscriptionBroker))
      return null;
    return caller.userId;
  },
  service: () => subscriptionRuntime(true),
});

export const POST = withDeviceAuthorization(handlePOST);
