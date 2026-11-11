'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { downloadServerFile } from '@/lib/web-connection/assets'
import { withBasePath } from '@/lib/base-path'
import { TASK_FILE_MAX_BYTES, TASK_FILE_MAX_COUNT, type TaskFileList } from '@/lib/task-attachments/contract'

type Trigger = (label: string, open: () => void) => ReactNode

export function TaskAttachments({ taskId, trigger }: { taskId: string; trigger: Trigger }) {
  const [open, setOpen] = useState(false)
  const t = useTranslations('TaskAttachments')
  return <>
    {trigger(t('title'), () => setOpen(true))}
    <Dialog open={open} onOpenChange={setOpen}>
      {open && <DialogContent>
        <DialogHeader><DialogTitle>{t('title')}</DialogTitle></DialogHeader>
        <FileList taskId={taskId} />
      </DialogContent>}
    </Dialog>
  </>
}

function FileList({ taskId }: { taskId: string }) {
  const t = useTranslations('TaskAttachments')
  const common = useTranslations('Common')
  const input = useRef<HTMLInputElement>(null)
  const [list, setList] = useState<TaskFileList | null>(null)
  const [readError, setReadError] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [version, setVersion] = useState(0)
  const [pending, setPending] = useState<{ file: File; id: string } | null>(null)
  const endpoint = withBasePath(`/api/tasks/${taskId}/attachments`)
  useEffect(() => {
    const controller = new AbortController()
    setReadError(false)
    fetch(endpoint, { signal: controller.signal, cache: 'no-store' }).then(async response => {
      if (!response.ok) throw new Error('read')
      const result: TaskFileList = await response.json()
      if (!controller.signal.aborted) setList(result)
    }).catch(() => {
      if (!controller.signal.aborted) { setList(null); setReadError(true) }
    })
    return () => controller.abort()
  }, [endpoint, version])

  async function change(id: string, file?: File) {
    if (busy) return
    setError('')
    if (!file) setPending(null)
    if (file && (file.size === 0 || file.size > TASK_FILE_MAX_BYTES)) {
      setError(t('size'))
      setPending(null)
      return
    }
    setBusy(true)
    try {
      const body = new FormData()
      if (file) body.set('file', file)
      const response = await fetch(`${endpoint}?id=${id}`, file ? { method: 'POST', body } : { method: 'DELETE' })
      if (!response.ok) {
        const code = (await response.json().catch(() => ({}))).error
        setError(code === 'tooMany' ? t('limit') : code === 'tooLarge' ? t('size') : t('failed'))
        return
      }
      setPending(null)
      setList(null)
    } catch {
      setError(t('failed'))
    } finally {
      setBusy(false)
      setVersion(n => n + 1)
    }
  }
  async function download(id: string, name: string) {
    setError('')
    try {
      const asset = await downloadServerFile(`${endpoint}?id=${id}`)
      const link = document.createElement('a')
      link.href = asset.url
      link.download = name
      link.click()
      window.setTimeout(asset.revoke, 60_000)
    } catch { setError(t('downloadFailed')) }
  }
  return <div className="grid min-w-0 gap-3">
    {readError ? <div role="alert">{t('readFailed')} <Button variant="ghost" size="sm" onClick={() => setVersion(n => n + 1)}>{common('retry')}</Button></div>
      : !list ? <span role="status">{common('loading')}</span>
      : <>
        {list.files.length ? <ul className="grid gap-1">
          {list.files.map(file => <li key={file.id} className="flex min-w-0 items-center gap-2">
            <button type="button" title={file.name} className="min-w-0 flex-1 truncate text-start underline" onClick={() => { void download(file.id, file.name) }}>{file.name}</button>
            {list.canEdit && <Button size="sm" variant="ghost" disabled={busy} aria-label={t('remove', { name: file.name })} onClick={() => { void change(file.id) }}>{common('remove')}</Button>}
          </li>)}
        </ul> : <p className="text-sm text-muted-foreground">{t('empty')}</p>}
        {list.canEdit && <>
          <input type="file" hidden ref={input} onChange={event => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            if (file) { const id = crypto.randomUUID(); setPending({ file, id }); void change(id, file) }
          }} />
          {list.files.length >= TASK_FILE_MAX_COUNT && <p className="text-sm text-muted-foreground">{t('limit')}</p>}
          <div><Button size="sm" disabled={busy || list.files.length >= TASK_FILE_MAX_COUNT} onClick={() => input.current?.click()}>{t('add')}</Button></div>
        </>}
      </>}
    {busy && <span role="status">{common('saving')}</span>}
    {error && <div role="alert">{error} {pending && list?.canEdit && <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void change(pending.id, pending.file) }}>{common('retry')}</Button>}</div>}
  </div>
}
