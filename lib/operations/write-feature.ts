import { deploymentSwitch } from '@/lib/deployment-switches'
/** Ordinary features ship on; provider readiness and per-action authority are
 * still checked by the existing runtime and durable execution path. */
export const PERSONAL_WRITES_ENABLED: boolean = true

/** Server configuration controls availability, never provider authority;
 * request bodies, model output and browser parameters cannot change this gate.
 * The regular per-tool permission and durable execution checks still apply.
 * PostHog's mikka-personal-writes-off is the incident kill switch. */
export function personalWritesEnabled(): boolean {
  return PERSONAL_WRITES_ENABLED && deploymentSwitch('personalWrites')
}
