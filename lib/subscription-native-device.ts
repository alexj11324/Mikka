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
  device: { enabled: boolean; kind: string; harnesses: { subscriptionBroker?: boolean }[] } | null,
): boolean {
  return Boolean(device?.enabled && device.kind === 'local' && device.harnesses.some(h => h.subscriptionBroker))
}
