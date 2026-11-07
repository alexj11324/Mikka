// What the 账户 slot receives (docs/ui-overlay.md). Its saves come from
// hooks/settings/use-account.ts.

export type SettingsAccountProps = {
  user: { name: string; email: string; image?: string | null }
  onSignOut: () => void
  signingOut: boolean
}
