/**
 * Which devices may take a run's subscription access lease
 * (`/v1/devices/:id/runs/:runId/subscription-lease`): a person's own device
 * running the daemon is a runner like E2B (docs/design/orchestration.md §3,
 * §6). Both local and cloud runners receive the access token during run
 * preparation, then connect directly to the provider. A cloud token must
 * name this exact task machine. The lease still checks the initial run's
 * owner, device, lifetime and subscription (SubscriptionService.nativeRun).
 * Natural token expiry uses the same endpoint in the background; provider
 * and tool operations do not call it for authorization (#1505).
 */
export function leaseDevice(
  device: { enabled: boolean; kind: string; harnesses: { subscriptionBroker?: boolean; subscriptionPreflight?: unknown }[] } | null,
  deviceId?: string,
  scopeDeviceId?: string,
): boolean {
  if (!device?.enabled || !device.harnesses.some(h => h.subscriptionBroker && !h.subscriptionPreflight)) return false
  if (scopeDeviceId && scopeDeviceId !== deviceId) return false
  return device.kind === 'local' || (device.kind === 'cloud' && Boolean(deviceId) && scopeDeviceId === deviceId)
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
