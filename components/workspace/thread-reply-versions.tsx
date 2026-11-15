'use client'

import { useRef, useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { createThreadReplyVersion, getThreadReplyVersions } from '@/app/actions/agents'
import { useActionError } from '@/lib/use-action-error'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import { FieldError } from '@/components/ui/field'
import { AgentMarkdown } from './agent-markdown'

export function ThreadReplyVersions({ issueId,runId,anchorRunId,anchorKey,operation,text,canRun,refresh }: {
  issueId:string|null; runId:string; anchorRunId:string; anchorKey:string; operation:'edit'|'rerun'; text:string; canRun:boolean; refresh:()=>void
}) {
  const t = useTranslations('IssueThreads')
  const actionError = useActionError()
  const [open,setOpen] = useState(false), [selected,setSelected] = useState('original')
  const [draft,setDraft] = useState(text), [busy,setBusy] = useState(false), [error,setError] = useState('')
  const pending = useRef<{ id:string; text:string } | null>(null)
  const { data,mutate,error:readError } = useSWR(open ? ['reply-versions',issueId,runId] : null, () => getThreadReplyVersions(issueId,runId))
  const versions = data?.filter(row => row.anchorRunId===anchorRunId && row.anchorKey===anchorKey) ?? []
  const version = versions.find(value => value.id===selected)
  const output=version ? version.output : operation==='edit' ? versions[0]?.originalOutput : text
  const pullRequest=version ? version.pullRequest : versions[0]?.originalPullRequest
  const label = operation==='edit' ? t('versionEdit') : t('versionRerun')
  async function submit() {
    if (busy || !canRun) return
    const value = draft.trim()
    if (operation==='edit' && !value) return
    const request = pending.current?.text===value ? pending.current : {id:crypto.randomUUID(),text:value}
    pending.current=request
    setBusy(true); setError('')
    try {
      const base = {anchorKey,anchorRunId,requestId:request.id}
      const result=await createThreadReplyVersion({issueId,runId,change:operation==='edit' ? {...base,operation,text:value} : {...base,operation}})
      if (result.error) { setError(actionError(result.error)); return }
      pending.current=null
      await mutate()
      setSelected(result.versionId)
      refresh()
    } catch { setError(t('loadFailed')) }
    finally { setBusy(false) }
  }
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger render={<Button type="button" size="xs" variant="ghost" />}>{label}</DialogTrigger>
    <DialogContent closeLabel={t('versionClose')}>
      <DialogTitle>{label}</DialogTitle>
      <DialogDescription>{t('versionEffects')}</DialogDescription>
      {versions.length>0 && <NativeSelect aria-label={t('versionHistory')} value={selected} onChange={event=>{
        setSelected(event.target.value)
        setDraft(versions.find(value=>value.id===event.target.value)?.text ?? text)
      }}>
        <NativeSelectOption value="original">{t('versionOriginal')}</NativeSelectOption>
        {versions.map((row,index)=><NativeSelectOption key={row.id} value={row.id}>{t('versionNumber',{number:index+2})}</NativeSelectOption>)}
      </NativeSelect>}
      {operation==='edit' ? <Textarea aria-label={t('versionEdit')} value={draft} maxLength={10000} onChange={event=>setDraft(event.target.value)} />
        : <div className="max-h-52 overflow-y-auto"><AgentMarkdown text={version?.output ?? (version ? t('versionPending') : text)} /></div>}
      {operation==='edit' && output && <div className="max-h-52 overflow-y-auto"><AgentMarkdown text={output} /></div>}
      {pullRequest && pullRequest.startsWith('https://github.com/') && <a className="text-sm underline" href={pullRequest} target="_blank" rel="noreferrer">{t('versionPullRequest')}</a>}
      {readError && <FieldError>{t('loadFailed')}</FieldError>}
      {error && <FieldError>{error}</FieldError>}
      <Button type="button" disabled={!canRun || busy || !data || (operation==='edit' && !draft.trim())} onClick={()=>void submit()}>{t('versionRun')}</Button>
    </DialogContent>
  </Dialog>
}
