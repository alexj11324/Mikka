'use client'

import { useEffect, useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import type { ArtifactDetail } from '@/lib/artifacts/types'
import { withBasePath } from '@/lib/base-path'
import { ArtifactKindIcon } from './artifact-card'
import { ArtifactDocument } from './artifact-document'
import { ArtifactFrame } from './artifact-frame'

/** A shared artifact at its latest version, read-only, for people who may not have a Mikka account. */
export function ArtifactShared({ token, artifact, markdown }: { token: string; artifact: ArtifactDetail; markdown: string | null }) {
  const t = useTranslations('Artifact')
  const format = useFormatter()
  const info = artifact.versions.find(item => item.version === artifact.latestVersion)
  // The viewer's own time zone is known only in the browser, so the time appears after mount.
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  const meta = info && mounted ? t('updated', { author: info.authorName, time: format.dateTime(new Date(info.createdAt), { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) }) : ''
  return <main className="flex h-dvh flex-col bg-background">
    <header className="flex h-13 shrink-0 items-center gap-2 px-4">
      <ArtifactKindIcon kind={artifact.kind} className="size-4 shrink-0 text-muted-foreground" />
      <h1 className="truncate text-sm font-medium">{artifact.title}</h1>
      <span className="shrink-0 text-xs text-muted-foreground">{t('version', { version: artifact.latestVersion })}</span>
    </header>
    {markdown !== null
      ? <ArtifactDocument title={artifact.title} markdown={markdown} author={info ?? { authorName: '', authorColor: null, authorShape: null }} meta={meta} quoted={[]} quoting={null} />
      : <ArtifactFrame src={withBasePath(`/api/artifacts/shared/${encodeURIComponent(token)}/frame`)} title={t('frameTitle', { title: artifact.title })} selecting={false} marked={[]} onQuote={() => undefined} onSelectOff={() => undefined} />}
  </main>
}
