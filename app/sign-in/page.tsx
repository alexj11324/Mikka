import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth, githubEnabled, authBaseURL } from '@/lib/auth'
import { AuthForm } from '@/components/auth-form'
import { safeAuthReturn } from '@/lib/auth-return'
import { isAcceptanceEnabled } from '@/lib/acceptance'
export const metadata: Metadata = {
  title: '登录 · Orvilo2',
  description: '登录 Orvilo2 工作台，继续管理任务与文档。',
}

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ oauth?: string; continue?: string; login?: string; error?: string; next?: string }> }) {
  const query = await searchParams
  const session = await auth.api.getSession({ headers: await headers() })
  if (session?.user) redirect(safeAuthReturn(query.next))
  if (isAcceptanceEnabled() && query.login !== '1' && !query.oauth && !query.continue && !query.error && !query.next) redirect('/api/acceptance')
  return <AuthForm next={safeAuthReturn(query.next)} mode="sign-in" githubEnabled={githubEnabled} oauthFailed={query.oauth === 'failed' || Boolean(query.error)} continueGitHub={query.continue === 'github'} callbackURL={authBaseURL ? `${authBaseURL.replace(/\/$/, '')}/api/auth/callback/github` : undefined} />
}
