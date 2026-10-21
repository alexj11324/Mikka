import { getSession } from '@/lib/session'
import { SettingsShell } from '@/components/settings/settings-shell'

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session?.user) return children
  return <SettingsShell user={session.user}>{children}</SettingsShell>
}
