'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { archiveProject, deleteProject, getProjectLifecycleImpact, restoreProject } from '@/app/actions/projects'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { Project } from './project-properties'

export function ProjectLifecycleControls({ project, readerId, admin, beforeOpen, onUpdated, onDeleted }: {
  project: Project
  readerId: string
  admin: boolean
  beforeOpen: () => Promise<boolean>
  onUpdated: () => void
  onDeleted: () => void
}) {
  const t = useTranslations('Projects.lifecycle')
  const common = useTranslations('Common')
  const [open, setOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState('')
  const inFlight = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const canSteer = project.canEditProperties === true
  const canDelete = canSteer && admin
  const key = open ? ['project-lifecycle-impact', readerId, project.workspaceId, project.id, project.revision] : null
  const { data, error, mutate } = useSWR(key, () => getProjectLifecycleImpact({ id: project.id, workspaceId: project.workspaceId }),
    { revalidateOnFocus: false, shouldRetryOnError: false })
  const current = data?.projectId === project.id && data.workspaceId === project.workspaceId && data.revision === project.revision ? data : undefined
  const counts = current ? Object.entries(current.counts).filter(([,count]) => count > 0) : []

  function close() {
    if (inFlight.current) return
    setOpen(false); setDeleting(false); setConfirmation(''); setFailure('')
  }

  async function change(action: 'archive' | 'restore' | 'delete') {
    if (!current || !canSteer || inFlight.current) return
    if (action === 'delete' && (!canDelete || !current.canDelete || confirmation.trim() !== current.name)) return
    inFlight.current = true
    setPending(true); setFailure('')
    const input = { id: current.projectId, workspaceId: current.workspaceId, revision: current.revision }
    try {
      const result = action === 'delete' ? await deleteProject({ ...input, confirmation })
        : action === 'restore' ? await restoreProject(input) : await archiveProject(input)
      if (!mounted.current) return
      const confirmed = action === 'delete'
        ? 'deleted' in result && result.deleted && result.projectId === current.projectId
        : 'project' in result && result.project?.id === current.projectId && Boolean(result.project.archivedAt) === (action === 'archive')
      if (!confirmed) {
        setFailure(('error' in result && result.error) || t('saveFailed'))
        onUpdated()
        void mutate()
        return
      }
      setOpen(false); setDeleting(false); setConfirmation('')
      onUpdated()
      if (action === 'delete') onDeleted()
    } catch {
      if (mounted.current) { setFailure(t('saveFailed')); onUpdated(); void mutate() }
    } finally {
      inFlight.current = false
      if (mounted.current) setPending(false)
    }
  }

  return <>
    <Button variant="outline" size="sm" onClick={async () => { if (await beforeOpen() && mounted.current) setOpen(true) }}>
      {canSteer ? t('actions') : t('impact')}
    </Button>
    <Dialog open={open} onOpenChange={next => { if (!next) close() }}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto" showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>{deleting ? t('deleteNamed', { name: project.name }) : t('impact')}</DialogTitle>
          <DialogDescription>{deleting ? t('permanent') : project.name}</DialogDescription>
        </DialogHeader>
        {error || (data && !current) ? <div role="alert" className="grid gap-2">
          <span>{t('loadFailed')}</span>
          <Button variant="outline" onClick={() => { onUpdated(); void mutate() }}>{common('retry')}</Button>
        </div> : !current ? <p role="status">{t('loading')}</p> : <>
          {counts.length ? <dl className="grid gap-1 text-sm">
            {counts.map(([kind,count]) => <div key={kind} className="flex justify-between gap-3">
              <dt>{t(`counts.${kind}` as never)}</dt><dd>{count}</dd>
            </div>)}
          </dl> : <p className="text-sm">{t('noLinks')}</p>}
          {deleting && canDelete ? <Label className="grid gap-2 text-sm">
            {t('confirmName', { name: current.name })}
            <Input value={confirmation} disabled={pending} onChange={event => setConfirmation(event.target.value)} />
          </Label> : canSteer && <p className="text-sm text-muted-foreground">{current.archivedAt ? t('restoreHint') : t('archiveHint')}</p>}
          {canDelete && !current.canDelete && <p className="text-sm text-muted-foreground">{t('deleteBlocked')}</p>}
          {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}
          <DialogFooter className="flex-wrap">
            {deleting && canDelete ? <>
              <Button variant="outline" disabled={pending} onClick={() => { setDeleting(false); setConfirmation(''); setFailure('') }}>{common('cancel')}</Button>
              <Button variant="destructive" disabled={pending || !current.canDelete || confirmation.trim() !== current.name} onClick={() => void change('delete')}>{t('delete')}</Button>
            </> : <>
              {canDelete && current.canDelete && <Button variant="destructive" disabled={pending} onClick={() => setDeleting(true)}>{t('delete')}</Button>}
              {canSteer && <Button disabled={pending} onClick={() => void change(current.archivedAt ? 'restore' : 'archive')}>{current.archivedAt ? t('restore') : t('archive')}</Button>}
            </>}
          </DialogFooter>
        </>}
      </DialogContent>
    </Dialog>
  </>
}
