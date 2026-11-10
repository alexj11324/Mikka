'use client'

import type { SettingsOrganizationProps } from '@/components/slots/settings-organization-contract'

/**
 * Enterprise v1 (#1608 P2, #1642): the Organization a Shared workspace is bound
 * to, its sign-in (OIDC/SAML, SCIM), resource policy and Organization audit.
 * The open-source UI draws none of it (#1646: the community UI is frozen), so
 * 组织 stays out of its sidebar; a layer that draws it sets the flag.
 */
export const ORGANIZATION_SETTINGS: boolean = false
export function OrganizationSettings(_props: SettingsOrganizationProps) { return null }
