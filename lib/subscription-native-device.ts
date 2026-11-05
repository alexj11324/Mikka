/**
 * Which devices may take a run's subscription access lease
 * (`/v1/devices/:id/runs/:runId/subscription-lease`): a person's own device
 * running the daemon is a runner like E2B (docs/design/orchestration.md §3,
 * §6). It gets the access token only, never the refresh grant. The hosted
 * E2B runner keeps its server-side broker and never takes a lease. The lease
 * itself still checks that the run is the owner's, on this device, live and
 * bound to the subscription (SubscriptionService.nativeRun).
 */
export function leaseDevice(
  device: { enabled: boolean; kind: string; harnesses: { subscriptionBroker?: boolean; subscriptionPreflight?: unknown }[] } | null,
): boolean {
  return Boolean(device?.enabled && device.kind === 'local' && device.harnesses.some(h => h.subscriptionBroker && !h.subscriptionPreflight))
}

/**
 * Which devices reach the hosted subscription broker
 * (`/v1/devices/:id/runs/:runId/subscription`): a Mikka cloud computer whose
 * device token is bound to this very device (`authenticateDevice` checked the
 * binding against a live cloud or thread machine), or a device on the
 * `MIKKA_BYOS_HOSTED_DEVICE_IDS` allow-list. Either way it must be enabled and
 * report the broker capability.
 */
export function hostedBrokerDevice(
  device: { enabled: boolean; kind: string; harnesses: { subscriptionBroker?: boolean; subscriptionPreflight?: unknown }[] } | null,
  deviceId: string,
  scopeDeviceId: string | undefined,
  allowList = process.env.MIKKA_BYOS_HOSTED_DEVICE_IDS ?? '',
): boolean {
  if (!device?.enabled || !device.harnesses.some(h => h.subscriptionBroker && !h.subscriptionPreflight)) return false
  return (device.kind === 'cloud' && scopeDeviceId === deviceId) || allowList.split(',').includes(deviceId)
}
