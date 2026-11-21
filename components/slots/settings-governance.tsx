'use client'

import type { SettingsGovernanceProps } from '@/components/slots/settings-governance-contract'

/**
 * Public types and fixtures use these no-content contracts. The official
 * provider renders seats, usage and approval templates (#1608, #1640).
 */
export function GovernancePlan(_props: SettingsGovernanceProps) { return null }
export function GovernanceUsage(_props: SettingsGovernanceProps) { return null }
export function GovernanceTemplates(_props: SettingsGovernanceProps) { return null }
