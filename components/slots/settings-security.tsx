'use client'

import { SecuritySettings } from '@/components/settings/security-settings'
import { GoogleSignInSettings } from '@/components/settings/google-sign-in-settings'
import type { SettingsSecurityProps } from '@/components/slots/settings-security-contract'

/** 安全: the password and signed-in devices, then signing in with Google. */
export function SecurityAndSignIn({ googleEnabled }: SettingsSecurityProps) {
  return <><SecuritySettings /><GoogleSignInSettings googleEnabled={googleEnabled} /></>
}
