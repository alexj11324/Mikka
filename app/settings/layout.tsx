import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { SettingsShell } from '@/components/settings/settings-shell'

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return children
  return <SettingsShell user={session.user}>{children}</SettingsShell>
}
