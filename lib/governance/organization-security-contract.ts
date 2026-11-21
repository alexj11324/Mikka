/** JSON contracts for the existing organization and personal security settings surfaces. */
export type OrganizationSecurityPolicy = {
  requireTwoFactor: boolean
  gracePeriodDays: number
  requiredAt: string | null
  graceEndsAt: string | null
}

export type PersonalSecurityState = {
  twoFactorEnabled: boolean
  sessionVerified: boolean
  organizations: Array<{
    organizationId: string
    name: string
    requireTwoFactor: boolean
    graceEndsAt: string | null
    status: 'not_required' | 'grace' | 'enrollment_required' | 'verification_required' | 'verified'
  }>
}

export type OrganizationInvitationInput = { emails: string[]; role?: 'admin' | 'member'; teamIds?: string[] }

export type OrganizationDomainVerification = {
  domain: { id: string; domain: string; verifiedAt: string | null; lastCheckedAt: string | null; verificationError: 'record_missing' | 'lookup_failed' | null }
  dns: { type: 'TXT'; name: string; value: string }
  verified: boolean
}
