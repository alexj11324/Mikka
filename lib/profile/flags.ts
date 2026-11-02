import { deploymentSwitch } from '@/lib/deployment-switches'

// The deployment's switch for proactive work (R-73, docs/design/proactive.md § 3),
// PostHog's mikka-proactive-profile-deployment (lib/deployment-switches.ts). Off
// unless it is on, so a self-hosted Mikka spends nothing on it. Each person also
// needs their own flag, mikka-proactive-profile (lib/profile/entitlement.ts).

/** Fact extraction and the nightly merge. */
export function profileEnabled(): boolean {
  return deploymentSwitch('proactiveProfile')
}
