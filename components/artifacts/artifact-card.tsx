'use client'

import { AppWindow, ChevronRight, FileText, type LucideProps } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import type { ArtifactSummary } from '@/lib/artifacts/types'
import type { ArtifactKind } from '@/lib/db/schema'
import { cn } from '@/lib/utils'

export function ArtifactKindIcon({ kind, ...props }: { kind: ArtifactKind } & LucideProps) {
  const Icon = kind === 'html' ? AppWindow : FileText
  return <Icon aria-hidden="true" {...props} />
}

/** 文档 · v2 */
export function useArtifactMeta() {
  const t = useTranslations('Artifact')
  return (artifact: Pick<ArtifactSummary, 'kind' | 'latestVersion'>) => t('cardMeta', { kind: t(artifact.kind === 'html' ? 'kindPage' : 'kindDocument'), version: artifact.latestVersion })
}

/** One output in the chat (Figma Chat/ArtifactCard 178:11656): sits under the text bubble, opens the reader. */
export function ArtifactCard({ artifact, onOpen }: { artifact: ArtifactSummary; onOpen: (id: string) => void }) {
  const meta = useArtifactMeta()
  return <Button variant="ghost" data-slot="artifact-card" onClick={() => onOpen(artifact.id)}
    className="h-16 w-full max-w-[26.25rem] justify-start gap-3 rounded-xl bg-muted/60 px-3 text-left font-normal hover:bg-muted">
    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-background text-foreground"><ArtifactKindIcon kind={artifact.kind} className="size-5" /></span>
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-sm font-medium text-foreground">{artifact.title}</span>
      <span className="truncate text-xs text-muted-foreground">{meta(artifact)}</span>
    </span>
    <ChevronRight data-icon="inline-end" className="text-muted-foreground" />
  </Button>
}

const CHIP = 'h-7 max-w-full justify-start gap-1.5 rounded-md px-2 text-xs'
const CHIP_ACTIVE = 'bg-sidebar-primary-soft text-sidebar-primary-soft-foreground hover:bg-sidebar-primary-soft hover:text-sidebar-primary-soft-foreground'

/** The same output as a small chip, for the chat beside the reader; the open one is blue. */
export function ArtifactChip({ artifact, active, onOpen }: { artifact: ArtifactSummary; active: boolean; onOpen: (id: string) => void }) {
  const t = useTranslations('Artifact')
  return <Button variant="secondary" data-slot="artifact-chip" aria-current={active || undefined} onClick={() => onOpen(artifact.id)} className={cn(CHIP, active && CHIP_ACTIVE)}>
    <ArtifactKindIcon kind={artifact.kind} data-icon="inline-start" />
    <span className="truncate">{artifact.title}</span>
    <span className={cn('shrink-0 font-normal', active ? 'text-sidebar-primary-soft-foreground' : 'text-muted-foreground')}>{t('version', { version: artifact.latestVersion })}</span>
  </Button>
}
