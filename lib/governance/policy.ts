/** Pure product entitlements. Authorization must be checked independently. */
export type DeploymentMode = 'cloud' | 'selfhost'
export type Plan = 'free' | 'pro' | 'enterprise'
export type PlanGrant = { plan: Plan; source: 'cloud' | 'license'; seatLimit: number | null; expiresAt: Date | null }
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

export function resolveEntitlements(input: { mode: DeploymentMode; kind: 'personal' | 'team'; grant?: PlanGrant | null; now?: Date }): Entitlements {
  const grant = input.grant
  const valid = grant && (!grant.expiresAt || grant.expiresAt.getTime() > (input.now ?? new Date()).getTime())
    && (input.mode === 'cloud' ? grant.source === 'cloud' : grant.source === 'license')
  const plan = input.kind === 'personal' ? 'free' : valid ? grant.plan : 'free'
  const community = input.mode === 'selfhost' && plan === 'free'
  const paid = plan === 'pro' || plan === 'enterprise'
  return {
    plan,
    edition: input.kind === 'personal' ? 'personal' : community ? 'community' : plan === 'enterprise' ? 'enterprise' : plan === 'pro' ? 'team_pro' : 'team_free',
    activeHumanLimit: input.kind === 'personal' ? 1 : community ? null : plan === 'free' ? 5 : valid ? grant.seatLimit : null,
    approvalTemplateLimit: paid ? plan === 'enterprise' ? 1000 : 100 : community ? 100 : 0,
    hostedMaxInFlight: plan === 'enterprise' ? 128 : plan === 'pro' ? 32 : 8,
    usageExport: paid || community,
    approvalTemplates: paid || community,
  }
}

/** Rejoining another workspace in the same organization does not buy a second seat. */
export function seatAdmissionAllowed(input: { current: number; limit: number | null; alreadyActive: boolean }): boolean {
  return input.alreadyActive || input.limit === null || input.current < input.limit
}

/** Formula prefixes must not become spreadsheet commands when an export is opened. */
export function csvCell(value: string | number | null): string {
  const text = value === null ? '' : String(value)
  const safe = /^[\s]*[=+@-]/.test(text) ? `'${text}` : text
  return `"${safe.replaceAll('"', '""')}"`
}
