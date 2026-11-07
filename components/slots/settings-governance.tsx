'use client'

import type { SettingsGovernanceProps } from '@/components/slots/settings-governance-contract'

/**
 * Team Free / Pro governance (#1608, #1640): plan and seats on 成员, the team
 * usage report on 用量, approval templates on 团队权限. The open-source UI adds
 * none of it (#1646: the community UI is frozen); the hosted layer draws all
 * three (docs/ui-overlay.md).
 */
export function GovernancePlan(_props: SettingsGovernanceProps) { return null }
export function GovernanceUsage(_props: SettingsGovernanceProps) { return null }
export function GovernanceTemplates(_props: SettingsGovernanceProps) { return null }
