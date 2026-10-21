import { redirect } from 'next/navigation'

export default async function PreviewSettingsPage({ searchParams }: { searchParams: Promise<{ workspace?: string; invite?: string }> }) {
  const query = await searchParams
  const params = new URLSearchParams()
  if (typeof query.workspace === 'string') params.set('workspace', query.workspace)
  if (query.invite === '1') params.set('invite', '1')
  const suffix = params.toString()
  redirect(`/settings/members${suffix ? `?${suffix}` : ''}`)
}
