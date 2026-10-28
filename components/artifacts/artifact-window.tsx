'use client'

import dynamic from 'next/dynamic'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { getThreadName } from '@/app/actions/agents'
import { CoordinatorChat } from '@/components/coordinator/coordinator-chat'
import { CoordinatorAvatar } from '@/components/nav/bot-avatar'
import { IssueThreadPanel } from '@/components/workspace/issue-thread-panel'
import type { ArtifactListItem } from '@/lib/artifacts/types'

const ArtifactViewer = dynamic(() => import('./artifact-viewer').then(module => module.ArtifactViewer), { ssr: false })

/**
 * An artifact opened from the Artifact page: the existing reader window
 * (F4 `395:27525`) with the conversation it came from on the right. One a
 * thread made sits beside that thread; one sent outside a thread sits beside
 * the Coordinator chat, as it does when opened from there.
 */
export function ArtifactWindow({ artifact, onChange, onClose, onOpenIssue }: { artifact: Pick<ArtifactListItem, 'id' | 'runId' | 'issueId'>; onChange: (id: string) => void; onClose: () => void; onOpenIssue: (id: string) => void }) {
  const tNav = useTranslations('Nav')
  const { runId, issueId } = artifact
  const { data: threadName } = useSWR(runId && issueId ? ['thread-name', runId] : null, () => getThreadName(runId!), { revalidateOnFocus: false })
  if (runId && issueId) return <ArtifactViewer artifactId={artifact.id} onArtifactChange={onChange} onClose={onClose} quotes={[]}
    bot={{ name: threadName ?? '', avatar: null }}
    chat={() => <IssueThreadPanel issueId={issueId} runId={runId} onClose={onClose} bare />} />
  return <ArtifactViewer artifactId={artifact.id} onArtifactChange={onChange} onClose={onClose} quotes={[]}
    bot={{ name: tNav('coordinator'), avatar: <CoordinatorAvatar size="pill" /> }}
    chat={slot => <CoordinatorChat onOpenIssue={onOpenIssue} compact embedded={slot} />} />
}
