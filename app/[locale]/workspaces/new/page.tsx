import { getLocale, getTranslations } from 'next-intl/server'
import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { ArrowLeft } from 'lucide-react'
import { auth } from '@/lib/auth'
import { Link, redirect } from '@/i18n/navigation'
import { buttonVariants } from '@/components/ui/button'
import { CreateWorkspaceForm } from '@/components/workspace/create-workspace-form'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Metadata')
  return { title: t('workspaceCreateTitle'), description: t('workspaceCreateDescription'), robots: { index: false, follow: false } }
}

export default async function NewWorkspacePage() {
  const i18nText = await getTranslations();
  const locale = await getLocale()
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect({ href: '/sign-in?next=%2Fworkspaces%2Fnew', locale })
  return <div className="flex min-h-dvh flex-col bg-background">
    <header className="flex items-center justify-between gap-4 px-4 py-5 sm:px-8">
      <Link href="/" className={buttonVariants({ variant: 'ghost', size: 'sm' })}><ArrowLeft data-icon="inline-start" />{i18nText("Devices.connect.back")}</Link>
      <span className="max-w-[60%] truncate text-xs text-muted-foreground" title={session.user.email}>{session.user.email}</span>
    </header>
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col px-6 pt-12 pb-16 sm:pt-24">
      <div className="mb-10 flex flex-col gap-3"><h1 className="text-3xl font-semibold tracking-tight">{i18nText("FeatureCopy.c_0155bce8")}</h1><p className="text-sm leading-relaxed text-muted-foreground">{i18nText("FeatureCopy.c_c2044c1b")}</p></div>
      <CreateWorkspaceForm />
    </main>
  </div>
}
