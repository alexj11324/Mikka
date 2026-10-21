import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth, githubEnabled } from '@/lib/auth'
import { AuthForm } from '@/components/auth-form'
import { safeAuthReturn } from '@/lib/auth-return'
export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const query = await searchParams
  const next = safeAuthReturn(query.next)
  const session = await auth.api.getSession({ headers: await headers() })
  if (session?.user) redirect(next)
  return <AuthForm next={next} mode="sign-up" githubEnabled={githubEnabled} />
}
