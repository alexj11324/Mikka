import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth, githubEnabled } from '@/lib/auth'
import { AuthForm } from '@/components/auth-form'
import { safeAuthReturn } from '@/lib/auth-return'
export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ next?: string; addAccount?: string }> }) {
  const query = await searchParams
  const next = safeAuthReturn(query.next)
  const session = await auth.api.getSession({ headers: await headers() })
  const addAccount = query.addAccount === '1'
  if (session?.user && !addAccount) redirect(next)
  return <AuthForm addAccount={addAccount} next={next} mode="sign-up" githubEnabled={githubEnabled} />
}
