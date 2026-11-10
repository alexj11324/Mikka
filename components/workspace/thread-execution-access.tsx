'use client'

import { useId, useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { getThreadExecutionAccess, revokeThreadExecutionGrant, saveThreadExecutionGrant } from '@/app/actions/resource-access'
import type { ThreadExecutionView } from '@/lib/thread-execution-view'
import { useActionError } from '@/lib/use-action-error'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Spinner } from '@/components/ui/spinner'
import { InlineLoadError } from '@/components/load-error'

export function ThreadExecutionAccess({threadId,workspaceId}:{threadId:string;workspaceId:string}) {
  const t=useTranslations('ResourceAccess')
  const {data,error,mutate}=useSWR(['thread-execution-access',threadId,workspaceId],()=>getThreadExecutionAccess(threadId,workspaceId))
  return <section className="flex flex-col gap-3 border-t pt-4"><h3 className="text-sm font-medium">{t('executionTitle')}</h3><p className="text-xs text-muted-foreground">{t('executionDescription')}</p>
    {error?<InlineLoadError message={t('loadFailed')} retryLabel={t('retry')} onRetry={()=>{void mutate()}} />:!data?<Spinner aria-label={t('loading')} />
      :data.canManage?<ExecutionGrantForm threadId={threadId} workspaceId={workspaceId} data={data} saved={async()=>{await mutate()}} />:null}
  </section>
}

function ExecutionGrantForm({threadId,workspaceId,data,saved}:{threadId:string;workspaceId:string;data:ThreadExecutionView;saved:()=>Promise<void>}) {
  const t=useTranslations('ResourceAccess'),actionError=useActionError(),id=useId()
  const [actorId,setActorId]=useState(''),[credentialId,setCredentialId]=useState(''),[model,setModel]=useState('')
  const [harness,setHarness]=useState<'claude_code'|'codex'>('claude_code')
  const [minutes,setMinutes]=useState(60),[turnMinutes,setTurnMinutes]=useState(15),[hours,setHours]=useState(24)
  const [confirmed,setConfirmed]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState('')
  const connection=data.connections.find(item=>item.id===credentialId)
  async function save() {
    if(pending||!confirmed)return
    setPending(true);setError('')
    try{
      const result=await saveThreadExecutionGrant(threadId,workspaceId,{actorId,credentialId,model,harness,totalComputeSeconds:minutes*60,
        maxTurnSeconds:turnMinutes*60,expiresAt:new Date(Date.now()+hours*3_600_000).toISOString(),confirmExternalResourceUse:true})
      if(result.error){setError(actionError(result.error));return}
      setConfirmed(false);await saved()
    }catch{setError(t('saveFailed'))}finally{setPending(false)}
  }
  async function revoke(grantId:string,sourceId:string) {
    if(pending)return
    setPending(true);setError('')
    try{const result=await revokeThreadExecutionGrant(sourceId,workspaceId,grantId);if(result.error)setError(actionError(result.error));else await saved()}
    catch{setError(t('saveFailed'))}finally{setPending(false)}
  }
  return <>
    <div className="flex flex-col gap-2">{data.grants.map(grant=><div key={grant.id} className="flex items-center justify-between gap-3 rounded-lg border p-3"><div className="min-w-0 text-xs"><p className="break-words font-medium">{data.members.find(member=>member.id===grant.actorId)?.name||t('unavailableMember')} · {grant.model}</p><p>{t('remainingMinutes',{minutes:Math.floor(grant.remainingComputeSeconds/60)})} · {t(grant.current?'activeGrant':'inactiveGrant')}</p><p>{t('externalCostUnknown')}</p></div>{grant.current&&<Button type="button" variant="outline" size="sm" disabled={pending} onClick={()=>{void revoke(grant.id,grant.threadId)}}>{t('revoke')}</Button>}</div>)}</div>
    {!data.connections.length?<p className="text-sm text-muted-foreground">{t('noConnections')}</p>:!data.members.length?<p className="text-sm text-muted-foreground">{t('noMembers')}</p>:<form className="flex flex-col gap-3" onSubmit={event=>{event.preventDefault();void save()}}>
      <Field><FieldLabel htmlFor={`${id}-actor`}>{t('chooseMember')}</FieldLabel><NativeSelect id={`${id}-actor`} value={actorId} disabled={pending} onChange={event=>{setActorId(event.target.value);setConfirmed(false)}}><NativeSelectOption value="">{t('chooseMember')}</NativeSelectOption>{data.members.map(member=><NativeSelectOption key={member.id} value={member.id}>{member.name||t('unavailableMember')}</NativeSelectOption>)}</NativeSelect></Field>
      <Field><FieldLabel htmlFor={`${id}-connection`}>{t('connection')}</FieldLabel><NativeSelect id={`${id}-connection`} value={credentialId} disabled={pending} onChange={event=>{const next=data.connections.find(item=>item.id===event.target.value);setCredentialId(event.target.value);setModel('');setHarness(next?.harnesses.includes('claude_code')?'claude_code':'codex');setConfirmed(false)}}><NativeSelectOption value="">{t('chooseConnection')}</NativeSelectOption>{data.connections.map(item=><NativeSelectOption key={item.id} value={item.id}>{item.name||item.provider}</NativeSelectOption>)}</NativeSelect></Field>
      {connection&&<><Field><FieldLabel htmlFor={`${id}-model`}>{t('model')}</FieldLabel><NativeSelect id={`${id}-model`} value={model} disabled={pending} onChange={event=>{setModel(event.target.value);setConfirmed(false)}}><NativeSelectOption value="">{t('chooseModel')}</NativeSelectOption>{connection.models.map(value=><NativeSelectOption key={value} value={value}>{value}</NativeSelectOption>)}</NativeSelect></Field>
        <Field><FieldLabel htmlFor={`${id}-harness`}>{t('harness')}</FieldLabel><NativeSelect id={`${id}-harness`} value={harness} disabled={pending} onChange={event=>{setHarness(event.target.value as 'claude_code'|'codex');setConfirmed(false)}}>{connection.harnesses.filter(value=>value==='claude_code'||value==='codex').map(value=><NativeSelectOption key={value} value={value}>{value==='claude_code'?'Claude Code':'Codex'}</NativeSelectOption>)}</NativeSelect></Field></>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Field><FieldLabel htmlFor={`${id}-total`}>{t('totalMinutes')}</FieldLabel><Input id={`${id}-total`} type="number" required min={1} max={1440} step={1} value={minutes} disabled={pending} onChange={event=>{setMinutes(event.target.valueAsNumber);setConfirmed(false)}} /></Field><Field><FieldLabel htmlFor={`${id}-turn`}>{t('turnMinutes')}</FieldLabel><Input id={`${id}-turn`} type="number" required min={1} max={Math.min(minutes,60)} step={1} value={turnMinutes} disabled={pending} onChange={event=>{setTurnMinutes(event.target.valueAsNumber);setConfirmed(false)}} /></Field><Field><FieldLabel htmlFor={`${id}-hours`}>{t('expiryHours')}</FieldLabel><Input id={`${id}-hours`} type="number" required min={1} max={720} step={1} value={hours} disabled={pending} onChange={event=>{setHours(event.target.valueAsNumber);setConfirmed(false)}} /></Field></div>
      <Field orientation="horizontal"><Checkbox id={`${id}-confirm`} checked={confirmed} disabled={pending} onCheckedChange={value=>setConfirmed(value===true)} /><FieldLabel htmlFor={`${id}-confirm`}>{t('executionConfirm')}</FieldLabel></Field>
      <Button type="submit" disabled={pending||!confirmed||!actorId||!credentialId||!model||!connection?.harnesses.includes(harness)}>{pending&&<Spinner />}{t('authorize')}</Button>
    </form>}
    {error&&<FieldError>{error}</FieldError>}
  </>
}

/** Commenting never silently chooses the owner's resources. Continuing is an
 * explicit mode tied to a live, bounded grant; the server rechecks admission. */
export function ThreadExecutionChoice({threadId,workspaceId,value,onChange,active}:{threadId:string;workspaceId:string;value:string;onChange:(value:string)=>void;active:boolean}) {
  const t=useTranslations('ResourceAccess'),id=useId()
  const {data,error,mutate}=useSWR(['thread-execution-access',threadId,workspaceId],()=>getThreadExecutionAccess(threadId,workspaceId))
  const grants=data?.canContinue?data.grants.filter(grant=>grant.current&&grant.remainingComputeSeconds>=grant.maxTurnSeconds):[]
  const valid=!value||grants.some(grant=>grant.id===value)
  return <div className="flex flex-col gap-1 px-3"><Field><FieldLabel htmlFor={id}>{t('sendMode')}</FieldLabel><NativeSelect id={id} value={value} onChange={event=>onChange(event.target.value)}><NativeSelectOption value="">{t('commentOnly')}</NativeSelectOption>{!valid&&<NativeSelectOption value={value} disabled>{t('inactiveGrant')}</NativeSelectOption>}{grants?.map(grant=><NativeSelectOption key={grant.id} value={grant.id} disabled={active}>{t('continueWith',{model:grant.model,minutes:Math.floor(grant.remainingComputeSeconds/60)})}</NativeSelectOption>)}</NativeSelect></Field><p className="text-xs text-muted-foreground">{t(!valid?'grantUnavailable':value?'externalCostUnknown':active?'commentWhileRunning':'commentHint')}</p>{error&&<InlineLoadError message={t('loadFailed')} retryLabel={t('retry')} onRetry={()=>{void mutate()}} />}</div>
}
