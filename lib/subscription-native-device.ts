/**
 * Which devices may send a run's model requests to the subscription proxy
 * (`/v1/devices/:id/runs/:runId/subscription`), where the server adds the
 * owner's credential. A person's own device is a runner like the hosted one
 * (docs/design/orchestration.md §3); the token never leaves the server. The
 * proxy still checks that the run is the owner's, on this device, live and
 * bound to the subscription (SubscriptionService.nativeRun).
 */
export function nativeProxyDevice(
  device: { enabled: boolean; kind: string; harnesses: { subscriptionBroker?: boolean }[] } | null,
  deviceId: string,
  hostedDeviceIds: string = process.env.MIKKA_BYOS_HOSTED_DEVICE_IDS ?? '',
): boolean {
  if (!device?.enabled || !device.harnesses.some(h => h.subscriptionBroker)) return false
  return device.kind === 'local' || hostedDeviceIds.split(',').includes(deviceId)
}
