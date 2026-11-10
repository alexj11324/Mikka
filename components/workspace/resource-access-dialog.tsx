'use client'

import { useId, useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { UsersRound, X } from 'lucide-react'
import { getResourceAccess, saveResourceAccess } from '@/app/actions/resource-access'
import type { ResourceAccessView } from '@/lib/resource-access/view'
import type { ResourceAction, ResourceReference } from '@/lib/resource-access/contract'
import { useActionError } from '@/lib/use-action-error'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Spinner } from '@/components/ui/spinner'
import { InlineLoadError } from '@/components/load-error'
import { ThreadExecutionAccess } from './thread-execution-access'

const LEVELS = ['reader','commenter','editor','approver'] as const
const levels: Record<typeof LEVELS[number],ResourceAction[]> = {
  reader:['canReadContent'],commenter:['canReadContent','canComment'],
  editor:['canReadContent','canComment','canSteer'],approver:['canReadContent','canComment','canSteer','canApprove'],
}
const level = (actions:ResourceAction[]) => actions.includes('canApprove')?'approver':actions.includes('canSteer')?'editor':actions.includes('canComment')?'commenter':'reader'
export const localDateTime = (value:string|null) => {
  if (!value) return ''
  const date=new Date(value)
  return new Date(date.getTime()-date.getTimezoneOffset()*60_000).toISOString().slice(0,16)
}

/** One sharing action is used in the existing resource menus on web and
 * desktop. The server supplies both the resource ACL and editable membership. */
export function ResourceAccessButton({ reference }: {reference:ResourceReference}) {
  const t=useTranslations('ResourceAccess')
  const [open,setOpen]=useState(false)
  return <>
    <Button type="button" variant="ghost" size="icon-sm" aria-label={t('manage')} title={t('manage')} onClick={()=>setOpen(true)}><UsersRound /></Button>
    <ResourceAccessDialog reference={reference} open={open} onOpenChange={setOpen} />
  </>
}

/** The panel owns state; an official header menu opens the same access form. */
export function ResourceAccessDialog({reference,open,onOpenChange}:{reference:ResourceReference;open:boolean;onOpenChange:(open:boolean)=>void}) {
  const t=useTranslations('ResourceAccess')
  const {data,error,mutate}=useSWR(open?['resource-access',reference.kind,reference.id,reference.workspaceId]:null,()=>getResourceAccess(reference))
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-lg">
      <DialogHeader><DialogTitle>{t('title')}</DialogTitle><DialogDescription>{t('description')}</DialogDescription></DialogHeader>
      {error?<InlineLoadError message={t('loadFailed')} retryLabel={t('retry')} onRetry={()=>{void mutate()}} />
        :!data?<Spinner aria-label={t('loading')} />
        :<ResourceAccessForm key={`${reference.id}:${data.policy?.revision}`} reference={reference} access={data} saved={async()=>{await mutate()}} />}
      {data?.capabilities.canManageAccess&&reference.kind==='thread'&&<ThreadExecutionAccess threadId={reference.id} workspaceId={reference.workspaceId} />}
    </DialogContent></Dialog>
}

function ResourceAccessForm({reference,access,saved}:{reference:ResourceReference;access:ResourceAccessView;saved:()=>Promise<void>}) {
  const t=useTranslations('ResourceAccess'),actionError=useActionError(),formId=useId()
  const [visibility,setVisibility]=useState<'shared'|'private'>(access.policy?.visibility==='shared'?'shared':'private')
  const [grants,setGrants]=useState(access.grants)
  const [member,setMember]=useState('')
  const [confirmed,setConfirmed]=useState(false)
  const [pending,setPending]=useState(false),[error,setError]=useState(''),[success,setSuccess]=useState(false)
  if(!access.policy)return <p role="status">{t('unavailable')}</p>
  const policy=access.policy
  if(!access.capabilities.canManageAccess)return <p className="text-sm text-muted-foreground">{t(policy.visibility==='shared'?'sharedDescription':'privateDescription')}</p>
  const remaining=access.members.filter(person=>person.id!==policy.ownerId&&!grants.some(grant=>grant.subjectId===person.id))
  const expansion=visibility==='shared'&&policy.visibility!=='shared'||grants.some(grant=>{
    const old=access.grants.find(item=>item.subjectId===grant.subjectId)
    return !old||grant.capabilities.some(action=>!old.capabilities.includes(action))||!!old.expiresAt&&(!grant.expiresAt||Date.parse(grant.expiresAt)>Date.parse(old.expiresAt))
  })
  const changed=visibility!==policy.visibility||JSON.stringify(grants)!==JSON.stringify(access.grants)
  async function save() {
    if(pending)return
    setPending(true);setError('');setSuccess(false)
    try{
      const result=await saveResourceAccess(reference,{expectedRevision:policy.revision,visibility,grants,confirmExpansion:confirmed})
      if(result.error){setError(actionError(result.error));return}
      setSuccess(true);await saved()
    }catch{setError(t('saveFailed'))}finally{setPending(false)}
  }
  return <form className="flex flex-col gap-4" onSubmit={event=>{event.preventDefault();void save()}}>
    <FieldGroup>
    <Field><FieldLabel htmlFor={`${formId}-visibility`}>{t('visibility')}</FieldLabel><NativeSelect id={`${formId}-visibility`} value={visibility} disabled={pending} onChange={event=>{setVisibility(event.target.value as 'shared'|'private');setConfirmed(false)}}>
      <NativeSelectOption value="shared">{t('shared')}</NativeSelectOption><NativeSelectOption value="private">{t('private')}</NativeSelectOption>
    </NativeSelect><p className="text-xs text-muted-foreground">{t(visibility==='shared'?'sharedDescription':'privateDescription')}</p></Field>
    <p className="text-xs text-muted-foreground">{t('parentBoundary')}</p>
    <FieldSet disabled={pending} className="min-w-0 gap-3"><FieldLegend variant="label">{t('members')}</FieldLegend>
      {grants.length===0&&<p className="text-xs text-muted-foreground">{t('noGrants')}</p>}
      {grants.map(grant=>{
        const person=access.members.find(candidate=>candidate.id===grant.subjectId)
        const id=`${formId}-${grant.subjectId}`
        return <div key={grant.subjectId} className="flex flex-col gap-2 rounded-lg border p-3">
          <div className="flex items-center justify-between gap-2"><span className="min-w-0 break-words text-sm">{person?.name||t('unavailableMember')}</span><Button type="button" variant="ghost" size="icon-xs" aria-label={t('removeMember')} onClick={()=>setGrants(current=>current.filter(item=>item.subjectId!==grant.subjectId))}><X /></Button></div>
          <Field><FieldLabel htmlFor={`${id}-level`}>{t('permission')}</FieldLabel><NativeSelect id={`${id}-level`} value={level(grant.capabilities)} onChange={event=>{setGrants(current=>current.map(item=>item.subjectId===grant.subjectId?{...item,capabilities:levels[event.target.value as typeof LEVELS[number]]}:item));setConfirmed(false)}}>{LEVELS.map(value=><NativeSelectOption key={value} value={value}>{t(value)}</NativeSelectOption>)}</NativeSelect></Field>
          <Field><FieldLabel htmlFor={`${id}-expiry`}>{t('expiresOptional')}</FieldLabel><Input id={`${id}-expiry`} type="datetime-local" value={localDateTime(grant.expiresAt)} onChange={event=>{const value=event.target.value;setGrants(current=>current.map(item=>item.subjectId===grant.subjectId?{...item,expiresAt:value?new Date(value).toISOString():null}:item));setConfirmed(false)}} /></Field>
        </div>
      })}
      {remaining.length>0&&<div className="flex items-end gap-2"><Field className="min-w-0 flex-1"><FieldLabel htmlFor={`${formId}-member`}>{t('addMember')}</FieldLabel><NativeSelect id={`${formId}-member`} value={member} onChange={event=>setMember(event.target.value)}><NativeSelectOption value="">{t('chooseMember')}</NativeSelectOption>{remaining.map(person=><NativeSelectOption key={person.id} value={person.id}>{person.name||t('unavailableMember')}</NativeSelectOption>)}</NativeSelect></Field><Button type="button" variant="outline" disabled={!member} onClick={()=>{setGrants(current=>[...current,{subjectId:member,capabilities:levels.reader,expiresAt:null}]);setMember('');setConfirmed(false)}}>{t('add')}</Button></div>}
    </FieldSet>
    {expansion&&<Field orientation="horizontal"><Checkbox id={`${formId}-confirm`} checked={confirmed} disabled={pending} onCheckedChange={value=>setConfirmed(value===true)} /><FieldLabel htmlFor={`${formId}-confirm`}>{t('confirmExpansion')}</FieldLabel></Field>}
    </FieldGroup>
    {error&&<FieldError>{error}</FieldError>}{success&&<p role="status" className="text-sm">{t('saved')}</p>}
    <Button type="submit" disabled={pending||!changed||expansion&&!confirmed}>{pending&&<Spinner />}{t('save')}</Button>
  </form>
}
