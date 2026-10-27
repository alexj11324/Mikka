import type { Metadata } from 'next'
import { getLocale, getTranslations } from 'next-intl/server'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { ArtifactShared } from '@/components/artifacts/artifact-shared'
import { sharedArtifact } from '@/lib/artifacts/store'

export const dynamic = 'force-dynamic'

// The share page anyone with the link can open (app.aspectlylabs.com/mikka/a/<token>).
// No sign-in; the token is the permission. The referrer is dropped so the
// token never leaks to a site the artifact links to.

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const found = await sharedArtifact((await params).token)
  const t = await getTranslations({ locale: await getLocale(), namespace: 'Artifact' })
  return { title: found?.title ?? t('notFoundTitle'), referrer: 'no-referrer', robots: { index: false, follow: false } }
}

export default async function SharedArtifactPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const found = await sharedArtifact(token)
  if (!found) {
    const t = await getTranslations({ locale: await getLocale(), namespace: 'Artifact' })
    return <main className="flex min-h-dvh items-center justify-center bg-background p-5"><Empty><EmptyHeader><EmptyTitle>{t('notFoundTitle')}</EmptyTitle><EmptyDescription>{t('sharedNotFoundHint')}</EmptyDescription></EmptyHeader></Empty></main>
  }
  const { content, ...artifact } = found
  return <ArtifactShared token={token} artifact={artifact} markdown={artifact.kind === 'markdown' ? content : null} />
}
