import { deploymentSwitch } from '@/lib/deployment-switches'
/** Ordinary features ship on; provider readiness and per-action authority are
 * still checked by the existing runtime and durable execution path. */
export const PERSONAL_WRITES_ENABLED: boolean = true

/** Server configuration controls availability, never provider authority;
 * request bodies, model output and browser parameters cannot change this gate.
 * The regular per-tool permission and durable execution checks still apply.
 * An explicit zero remains available as an incident kill switch. */
export function personalWritesEnabled(env: Record<string,string|undefined> = process.env): boolean {
  return PERSONAL_WRITES_ENABLED && deploymentSwitch('personalWrites', env)
}
