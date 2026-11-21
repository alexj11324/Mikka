'use client'
import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from '@/lib/intl/i18n-client'
import { listDependencyRepositories, replaceDependencyRepositories } from '@/app/actions/project-resources'
import { useActionError } from '@/lib/use-action-error'
import { settingsReadOptions } from '@/lib/settings-data'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FieldError } from '@/components/ui/field'
import { Label } from '@/components/ui/label'

export function ProjectDependencyRepositories({ workspaceId, projectId, readerId, readOnly, onSaved }: {
  workspaceId: string; projectId: string; readerId: string; readOnly: boolean; onSaved: () => void
}) {
  const t = useTranslations('Projects.dependencies'), common = useTranslations('Common'), actionError = useActionError()
  const [open, setOpen] = useState(false)
  const [edit, setEdit] = useState<{ revision: number; selected: string[] } | null>(null)
  const [saving, setSaving] = useState(false), [failure, setFailure] = useState<string | null>(null)
  const [opening, setOpening] = useState(0)
  const query = useSWR(open ? ['project-dependencies', readerId, workspaceId, projectId, opening] : null,
    () => listDependencyRepositories({ workspaceId, projectId }), { ...settingsReadOptions, revalidateOnMount: true, dedupingInterval: 0 })
  const data = query.data && !query.isValidating && !query.data.error && !query.error ? query.data : null
  const readError = query.error ? actionError() : query.data?.error ? actionError(query.data.error) : null
  const writable = !readOnly && data?.canReplace === true
  const selected = edit?.selected ?? data?.selected ?? []
  function toggle(id: string, checked: boolean) {
    if (!data || !writable) return
    setEdit({ revision: edit?.revision ?? data.revision, selected: checked ? [...selected, id] : selected.filter(value => value !== id) })
    setFailure(null)
  }
  async function save() {
    if (!edit || !writable) return
    setSaving(true); setFailure(null)
    try {
      const result = await replaceDependencyRepositories({ workspaceId, projectId, revision: edit.revision, repos: edit.selected })
      if (result.error) { setFailure(actionError(result.error)); setEdit(null); await query.mutate(); return }
      setOpen(false); setEdit(null); onSaved()
    } catch { setFailure(actionError()); setEdit(null); await query.mutate() }
    finally { setSaving(false) }
  }
  return <><Button variant="outline" size="sm" onClick={() => { setOpening(value => value + 1); setOpen(true); setEdit(null); setFailure(null) }}>{t('title')}</Button>
    <Dialog open={open} onOpenChange={value => { if (!saving) { setOpen(value); setEdit(null); setFailure(null) } }}>
      <DialogContent><DialogHeader><DialogTitle>{t('title')}</DialogTitle></DialogHeader>
        {readError ? <FieldError>{readError}<Button variant="link" onClick={() => void query.mutate()}>{common('retry')}</Button></FieldError>
          : !data ? <p role="status">{common('loading')}</p>
          : <div className="grid max-h-[55vh] gap-2 overflow-y-auto">
              {data.repositories.filter(repo => writable || data.selected.includes(repo.id)).map(repo =>
                <Label key={repo.id}><Checkbox checked={selected.includes(repo.id)} disabled={!writable || saving}
                  onCheckedChange={checked => toggle(repo.id, checked === true)} />{repo.name}</Label>)}
              {!(writable ? data.repositories : data.selected).length && <p>{t('empty')}</p>}
              {!readOnly && !data.canReplace && <p>{t('unavailable')}</p>}
            </div>}
        {failure && <FieldError>{failure}</FieldError>}
        <DialogFooter><Button variant="outline" disabled={saving} onClick={() => setOpen(false)}>{common('close')}</Button>
          {writable && <Button disabled={!edit || saving} onClick={() => void save()}>{common('save')}</Button>}</DialogFooter>
      </DialogContent>
    </Dialog></>
}
