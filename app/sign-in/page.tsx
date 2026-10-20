import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth, githubEnabled, authBaseURL } from '@/lib/auth'
import { AuthForm } from '@/components/auth-form'
export const metadata: Metadata = {
  title: '登录 · Orvilo2',
  description: '登录 Orvilo2 工作台，继续管理任务与文档。',
}

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ oauth?: string; continue?: string }> }) {
  const query = await searchParams
  const session = await auth.api.getSession({ headers: await headers() })
  if (session?.user) redirect('/')
  return <AuthForm mode="sign-in" githubEnabled={githubEnabled} oauthFailed={query.oauth === 'failed' || Boolean((query as Record<string, string>).error)} continueGitHub={query.continue === 'github'} callbackURL={authBaseURL ? `${authBaseURL.replace(/\/$/, '')}/api/auth/callback/github` : undefined} />
}
