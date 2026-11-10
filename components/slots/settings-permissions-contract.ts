// What 设置 › 团队权限's page receives (docs/ui-overlay.md): each policy's
// state, its save and its errors, from hooks/settings/use-team-permissions.ts.
import type { AppPolicyControl, ComputerPolicyControl, SharePolicyControl } from '@/hooks/settings/use-team-permissions'

export type SettingsPermissionsProps = {
  workspaceId: string
  /** 电脑操作; `state.enabled` is false where the deployment has no cloud computer (no row). */
  computer: ComputerPolicyControl
  /** 订阅与 API Key: sharing with teammates. */
  share: SharePolicyControl
  /** 允许使用的应用: per connected app. */
  apps: AppPolicyControl
}
