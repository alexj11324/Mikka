import { useRef, useState } from 'react'
import { Linking, TextInput, View } from 'react-native'
import { GlassButton } from '@/components/GlassButton'
import { Segmented } from '@/components/Segmented'
import { Text } from '@/components/Text'
import { api } from '@/lib/api'
import { mobileMessages } from '@/lib/messages'
import type { ThreadDetail } from '@/lib/types'
import { DESKTOP_RPC_VERSION } from '../../../../../lib/desktop-rpc/wire'

type Version = {id:string; text:string; anchorRunId:string; anchorKey:string; output:string|null; originalOutput:string|null; pullRequest:string|null; originalPullRequest:string|null}
async function rpc<T>(action:string,args:unknown[]): Promise<T> {
  const receipt = await api<{version:number;ok:boolean;result:T & {error?:string};error?:{code?:string}}>('/api/rpc',{method:'POST',body:{version:DESKTOP_RPC_VERSION,action,args}})
  if (receipt.version!==DESKTOP_RPC_VERSION || !receipt.ok || receipt.result?.error) throw Error(receipt.result?.error ?? receipt.error?.code ?? 'submissionUnconfirmed')
  return receipt.result
}

export function MobileReplyVersions({detail,runId,itemId,text,reload,working}:{
  detail:ThreadDetail|undefined;runId:string;itemId:string;text:string;reload:()=>Promise<void>;working:boolean
}) {
  const anchor=detail?.versionAnchors?.[itemId], copy=mobileMessages.IssueThreads
  const [open,setOpen]=useState(false), [busy,setBusy]=useState(false), [error,setError]=useState('')
  const [versions,setVersions]=useState<Version[]>([]),[selected,setSelected]=useState('original'),[draft,setDraft]=useState(text)
  const request=useRef<{id:string;text:string}|null>(null)
  if (!anchor || !detail?.issueId) return null
  const origin=anchor, issueId=detail.issueId, selectedVersion=versions.find(row=>row.id===selected)
  const output=selectedVersion ? selectedVersion.output : origin.operation==='edit' ? versions[0]?.originalOutput : null
  const pullRequest=selectedVersion ? selectedVersion.pullRequest : versions[0]?.originalPullRequest
  const label=origin.operation==='edit' ? copy.versionEdit : copy.versionRerun
  const fail=(e:unknown)=>setError((mobileMessages.Errors as Record<string,string>)[e instanceof Error ? e.message : ''] ?? mobileMessages.Coordinator.sendUncertain)
  async function read() {
    const rows=await rpc<Version[]>('agents.getThreadReplyVersions',[issueId,runId])
    setVersions(rows.filter(row=>row.anchorRunId===origin.runId && row.anchorKey===origin.key))
  }
  async function submit() {
    if (busy || working) return
    const value=draft.trim()
    const id=request.current?.text===value ? request.current.id : crypto.randomUUID()
    request.current={id,text:value}
    setBusy(true);setError('')
    try {
      const change={anchorRunId:origin.runId,anchorKey:origin.key,requestId:id,operation:origin.operation,...(origin.operation==='edit'?{text:value}:{})}
      const result=await rpc<{versionId:string}>('agents.createThreadReplyVersion',[{issueId,runId,change}])
      await read();setSelected(result.versionId);request.current=null;await reload()
    } catch(e){fail(e)} finally{setBusy(false)}
  }
  return <View style={{gap:4}}>
    <GlassButton label={open ? copy.versionClose : label} onPress={()=>{setOpen(!open);if(!open)void read().catch(fail)}} />
    {open && <>
      <Text>{copy.versionEffects}</Text>
      {versions.length>0 && <Segmented options={[{value:'original',label:copy.versionOriginal},...versions.map((row,i)=>({value:row.id,label:copy.versionNumber.replace('{number}',String(i+2))}))]}
        value={selected} onChange={id=>{setSelected(id);setDraft(versions.find(row=>row.id===id)?.text ?? text)}} />}
      {origin.operation==='edit' ? <TextInput multiline accessibilityLabel={label} value={draft} maxLength={10000} onChangeText={setDraft} /> : null}
      {output || selectedVersion ? <Text selectable>{output ?? copy.versionPending}</Text> : null}
      {pullRequest && pullRequest.startsWith('https://github.com/') ? <GlassButton label={copy.versionPullRequest} onPress={()=>void Linking.openURL(pullRequest).catch(fail)} /> : null}
      {error ? <Text accessibilityRole="alert">{error}</Text> : null}
      <GlassButton label={copy.versionRun} busy={busy} disabled={working || (origin.operation==='edit' && !draft.trim())} onPress={()=>void submit()} />
    </>}
  </View>
}
