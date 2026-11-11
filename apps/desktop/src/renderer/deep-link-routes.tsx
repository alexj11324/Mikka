import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { switchWorkspace } from '@/app/actions/workspace'
import { ArtifactShared } from '@/components/artifacts/artifact-shared'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { WorkspaceLoading } from '@/components/workspace/workspace-loading'
import NotFound from '@/components/app-shell/not-found'
import { withBasePath } from '@/lib/base-path'
import type { ArtifactDetail } from '@/lib/artifacts/types'
import { localeOf, navigate } from './location'
import { callAction, DesktopTransportError } from './rpc'

/** Resolve the same active membership and historical slug as the web's /w
 * route, then let the existing main-owned workspace switch set its selector. */
export function WorkspaceLinkRoute({ slug }: { slug: string }) {
  const [missing, setMissing] = useState(false)
  const [failure, setFailure] = useState<Error | null>(null)
  useEffect(() => {
    let active = true
    const source = window.location.href
    void (async () => {
      const resolved = await callAction<{ workspaceId: string; slug: string } | null>('desktop.workspaceLink', [slug])
      if (!active) return
      if (!resolved) { setMissing(true); return }
      const result = await switchWorkspace(resolved.workspaceId)
      if (!result.ok) throw new DesktopTransportError('desktop_request_failed')
      // The successful switch deliberately remounts owner caches before its
      // response reaches React. Complete this navigation only if the user has
      // not navigated elsewhere; main already fences stale account responses.
      if (window.location.href === source) navigate('/', true, { locale: localeOf(window.location.pathname) }, true)
    })().catch(error => { if (active) setFailure(error instanceof Error ? error : new DesktopTransportError('desktop_request_failed')) })
    return () => { active = false }
  }, [slug])
  if (failure) throw failure
  return missing ? <NotFound /> : <WorkspaceLoading />
}

/** The exact public reader, including its empty state. The share token retains
 * the web's existing permission; it is never an account/session credential. */
export function SharedArtifactRoute({ token }: { token: string }) {
  const t = useTranslations('Artifact')
  const [found, setFound] = useState<{ artifact: ArtifactDetail; markdown: string | null } | null | undefined>(undefined)
  const [failure, setFailure] = useState<Error | null>(null)
  useEffect(() => {
    const abort = new AbortController()
    void (async () => {
      const response = await fetch(withBasePath(`/api/artifacts/shared/${encodeURIComponent(token)}`), { cache: 'no-store', credentials: 'omit', signal: abort.signal })
      if (response.status === 404) { setFound(null); return }
      if (!response.ok) throw new DesktopTransportError('desktop_request_failed')
      const result = await response.json() as { artifact: ArtifactDetail; markdown: string | null }
      if (!abort.signal.aborted) setFound(result)
    })().catch(error => { if (!abort.signal.aborted) setFailure(error instanceof Error ? error : new DesktopTransportError('desktop_request_failed')) })
    return () => abort.abort()
  }, [token])
  if (failure) throw failure
  if (found === undefined) return <WorkspaceLoading />
  if (!found) return <main className="flex min-h-dvh items-center justify-center bg-background p-5"><Empty><EmptyHeader><EmptyTitle>{t('notFoundTitle')}</EmptyTitle><EmptyDescription>{t('sharedNotFoundHint')}</EmptyDescription></EmptyHeader></Empty></main>
  return <ArtifactShared token={token} artifact={found.artifact} markdown={found.markdown} />
}
