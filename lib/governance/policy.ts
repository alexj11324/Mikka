/** Pure product entitlements. Authorization must be checked independently. */
export type DeploymentMode = 'cloud' | 'selfhost'
export type Plan = 'free' | 'pro' | 'enterprise'
export type PlanGrant = { plan: Plan; source: 'cloud' | 'license'; seatLimit: number | null; expiresAt: Date | null;
  billingPlan?: Plan; billingExpiresAt?: Date | null }
export type GovernanceFeature = 'usageExport' | 'approvalTemplates'
export type Entitlements = {
  plan: Plan
  edition: 'personal' | 'community' | 'team_free' | 'team_pro' | 'enterprise'
  activeHumanLimit: number | null
  approvalTemplateLimit: number
  hostedMaxInFlight: number
  usageExport: boolean
  approvalTemplates: boolean
}

export function resolveEntitlements(input: { mode: DeploymentMode; kind: 'personal' | 'team'; grant?: PlanGrant | null; grants?: (PlanGrant | null | undefined)[]; now?: Date }): Entitlements {
  const now = (input.now ?? new Date()).getTime()
  const rank: Record<Plan, number> = { free: 0, pro: 1, enterprise: 2 }
  let plan: Plan = 'free'
  for (const grant of [...(input.grants ?? []), input.grant]) {
    if (!grant || input.kind === 'personal') continue
    const manual = (!grant.expiresAt || grant.expiresAt.getTime() > now)
      && (input.mode === 'cloud' ? grant.source === 'cloud' : grant.source === 'license') ? grant.plan : 'free'
    // Stripe grants must have a paid-through boundary; missing/expired delivery
    // cannot turn a subscription into permanent access. Self-host never uses it.
    const billed = input.mode === 'cloud' && grant.billingPlan && grant.billingExpiresAt && grant.billingExpiresAt.getTime() > now
      ? grant.billingPlan : 'free'
    if (rank[manual] > rank[plan]) plan = manual
    if (rank[billed] > rank[plan]) plan = billed
  }
  const community = input.mode === 'selfhost' && plan === 'free'
  const paid = plan === 'pro' || plan === 'enterprise'
  return {
    plan,
    edition: input.kind === 'personal' ? 'personal' : community ? 'community' : plan === 'enterprise' ? 'enterprise' : plan === 'pro' ? 'team_pro' : 'team_free',
    // #1849: plans allocate resources, not seats. Keep seatLimit in historical
    // grants for reversibility; it no longer denies Shared Workspace members.
    activeHumanLimit: input.kind === 'personal' ? 1 : null,
    approvalTemplateLimit: paid ? plan === 'enterprise' ? 1000 : 100 : community ? 100 : 0,
    hostedMaxInFlight: plan === 'enterprise' ? 128 : plan === 'pro' ? 32 : 8,
    usageExport: paid || community,
    approvalTemplates: paid || community,
  }
}

/** Shared workspaces are unlimited; the personal workspace boundary remains one owner. */
export function seatAdmissionAllowed(input: { current: number; limit: number | null; alreadyActive: boolean }): boolean {
  return input.alreadyActive || input.limit === null || input.current < input.limit
}

/** Formula prefixes must not become spreadsheet commands when an export is opened. */
export function csvCell(value: string | number | null): string {
  const text = value === null ? '' : String(value)
  const safe = /^[\s]*[=+@-]/.test(text) ? `'${text}` : text
  return `"${safe.replaceAll('"', '""')}"`
}
