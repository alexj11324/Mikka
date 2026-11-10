import type { Metadata } from 'next'
import { getLocale, getTranslations } from 'next-intl/server'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { ArtifactShared } from '@/components/artifacts/artifact-shared'
import { sharedArtifact } from '@/lib/artifacts/store'
import { authenticatedArtifactReader } from '@/lib/artifacts/route'
import { headers } from 'next/headers'

export const dynamic = 'force-dynamic'

// The share page anyone with the link can open (app.aspectlylabs.com/mikka/a/<token>).
// No sign-in; the token is the permission. The referrer is dropped so the
// token never leaks to a site the artifact links to.

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getLocale(), namespace: 'Artifact' })
  return { title: t('shareLink'), referrer: 'no-referrer', robots: { index: false, follow: false } }
}

export default async function SharedArtifactPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const found = await sharedArtifact(token, await authenticatedArtifactReader(new Headers(await headers())))
  if (!found) {
    const t = await getTranslations({ locale: await getLocale(), namespace: 'Artifact' })
    return <main className="flex min-h-dvh items-center justify-center bg-background p-5"><Empty><EmptyHeader><EmptyTitle>{t('notFoundTitle')}</EmptyTitle><EmptyDescription>{t('sharedNotFoundHint')}</EmptyDescription></EmptyHeader></Empty></main>
  }
  const { content, ...artifact } = found
  return <ArtifactShared token={token} artifact={artifact} markdown={artifact.kind === 'markdown' ? content : null} />
}
