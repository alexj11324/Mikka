// Hard spend guards for per-thread cloud machines. Kept free of server-only and
// database imports so the policy can be unit-tested and cited from docs.
//
// E2B's billing rules decide the budget shape: "You only pay while a sandbox is
// actively running. Once a sandbox is paused, killed or times out, billing stops
// immediately." Storage is included, so paused machines cost nothing and count
// only against state, never against the compute budget.
//
// Defaults for the 2 vCPU shape follow comparable products:
// - GitHub Codespaces grants free accounts 120 core-hours a month (60 real hours
//   on a 2-core machine) and a 12-hour maximum lifetime; one owner gets 60
//   running hours a month, matching that budget.
// - Cursor Pro runs up to 8 concurrent Cloud Agents per account; one owner gets
//   3 active machines so a single person cannot fill a workspace.
// - E2B counts concurrent *running* sandboxes per team (Hobby 20); 20 per
//   workspace stays inside that ceiling.

export type ThreadMachineLimits = Readonly<{
  /** Running machines (starting or running) one owner may hold at once. */
  perOwner: number
  /** Running machines one workspace may hold at once, across owners. */
  perWorkspace: number
  /** E2B-billed running hours an owner may consume in a rolling 30 days. */
  monthlyComputeHours: number
}>

export type ThreadMachineUsage = Readonly<{
  ownerActive: number
  workspaceActive: number
  ownerComputeHours: number
}>

function positive(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

/** Invalid or missing settings fall back to the documented defaults; there is no
 * way to configure "unlimited". */
export function threadMachineLimits(env: Record<string, string | undefined> = process.env): ThreadMachineLimits {
  return {
    perOwner: positive(env.MIKKA_THREAD_MACHINES_PER_OWNER, 3),
    perWorkspace: positive(env.MIKKA_THREAD_MACHINES_PER_WORKSPACE, 20),
    monthlyComputeHours: positive(env.MIKKA_THREAD_MACHINE_MONTHLY_COMPUTE_HOURS, 60),
  }
}

/** Returns the limit that blocks this provisioning, or null when it may proceed. */
export function threadMachineViolation(usage: ThreadMachineUsage, limits: ThreadMachineLimits): 'owner' | 'workspace' | 'budget' | null {
  if (usage.ownerActive >= limits.perOwner) return 'owner'
  if (usage.workspaceActive >= limits.perWorkspace) return 'workspace'
  if (usage.ownerComputeHours >= limits.monthlyComputeHours) return 'budget'
  return null
}
