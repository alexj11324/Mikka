// What the 密钥与登录 / 密钥与环境 slot receives (docs/ui-overlay.md). Its reads
// and saves come from hooks/settings/use-secrets.ts.
import type { ReactNode } from 'react'

export type SecretsSide = 'mine' | 'workspace'

export type SettingsSecretsProps = {
  side: SecretsSide
  onSide: (side: SecretsSide) => void
  /** Undefined in a preview, or before the workspace is known */
  workspaceId?: string
  workspaceName?: string
  /** What the workspace side shows without a workspace */
  waiting: ReactNode
}
