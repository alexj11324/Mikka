import { useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { BottomSheet, Host, Picker, Switch } from '@expo/ui'
import { Input } from '@/components/beui/components/input'
import { CardButton } from '@/components/cards'
import { Spinner } from '@/components/icons'
import { Text } from '@/components/Text'
import { ReadNotice } from '@/components/ReadNotice'
import { api, ApiError } from '@/lib/api'
import { apiCache } from '@/lib/api-cache'
import { useApi } from '@/lib/useApi'
import { mobileMessages } from '@/lib/messages'
import { colors } from '@/lib/theme'
import type { ResourceAccess, ThreadExecutionAccess } from '@/lib/types'
import type { ResourceKind } from '../../../lib/resource-access/contract'

const words=mobileMessages.ResourceAccess
const levels={reader:['canReadContent'],commenter:['canReadContent','canComment'],editor:['canReadContent','canComment','canSteer'],approver:['canReadContent','canComment','canSteer','canApprove']} as const
type Level=keyof typeof levels
type Grant=ResourceAccess['grants'][number]
const grantLevel=(grant:Grant):Level=>grant.capabilities.includes('canApprove')?'approver':grant.capabilities.includes('canSteer')?'editor':grant.capabilities.includes('canComment')?'commenter':'reader'
const failureLine=(error:unknown)=>error instanceof ApiError&&error.code in mobileMessages.Errors
  ? mobileMessages.Errors[error.code as keyof typeof mobileMessages.Errors] : words.saveFailed
const minutesLine=(seconds:number)=>words.remainingMinutes.replace('{minutes}',String(Math.floor(seconds/60)))

/** The same resource ACL as web/desktop, in the installed native sheet. */
export function ResourceAccessSheet({kind,id,open,onDismiss}:{kind:ResourceKind;id:string;open:boolean;onDismiss:()=>void}) {
  const path=`/api/resources/${kind}/${id}/access`
  const {data,error,reload}=useApi<ResourceAccess>(open?path:null)
  return <Host matchContents style={{height:0}}><BottomSheet isPresented={open} onDismiss={onDismiss} snapPoints={['full']} contentPadding={0} containerColor={colors.page}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
      <View style={styles.heading}><Text accessibilityRole="header" style={styles.title}>{words.title}</Text><CardButton label={mobileMessages.Common.close} onPress={onDismiss} /></View>
      <Text style={styles.note}>{words.description}</Text>
      <ReadNotice error={error} hasData={Boolean(data)} label={words.title} onRetry={reload} />
      {!data&&!error?<Spinner />:data?<AccessForm key={`${id}:${data.policy?.revision}`} data={data} path={path} />:null}
      {data?.capabilities.canManageAccess&&kind==='thread'?<ExecutionForm threadId={id} />:null}
    </ScrollView>
  </BottomSheet></Host>
}

function AccessForm({data,path}:{data:ResourceAccess;path:string}) {
  const [visibility,setVisibility]=useState<'shared'|'private'>(data.policy?.visibility==='shared'?'shared':'private')
  const [grants,setGrants]=useState(data.grants),[member,setMember]=useState('')
  const [confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const policy=data.policy
  if(!policy)return <Text style={styles.note}>{words.unavailable}</Text>
  if(!data.capabilities.canManageAccess)return <Text style={styles.note}>{policy.visibility==='shared'?words.sharedDescription:words.privateDescription}</Text>
  const remaining=data.members.filter(person=>person.id!==policy.ownerId&&!grants.some(grant=>grant.subjectId===person.id))
  const expansion=visibility==='shared'&&policy.visibility!=='shared'||grants.some(grant=>{
    const old=data.grants.find(item=>item.subjectId===grant.subjectId)
    return !old||grant.capabilities.some(action=>!old.capabilities.includes(action))||!!old.expiresAt&&(!grant.expiresAt||Date.parse(grant.expiresAt)>Date.parse(old.expiresAt))
  })
  const changed=visibility!==policy.visibility||JSON.stringify(grants)!==JSON.stringify(data.grants)
  const update=(subjectId:string,patch:Partial<Grant>)=>{setGrants(current=>current.map(grant=>grant.subjectId===subjectId?{...grant,...patch}:grant));setConfirmed(false)}
  async function save() {
    if(busy||!policy)return
    const context=apiCache.context()
    setBusy(true);setError('')
    try{
      await api(path,{method:'POST',body:{expectedRevision:policy.revision,visibility,grants,confirmExpansion:confirmed}})
      apiCache.commit(context,()=>apiCache.clear())
    }catch(failure){apiCache.commit(context,()=>setError(failureLine(failure)))}
    finally{apiCache.commit(context,()=>setBusy(false))}
  }
  return <View style={styles.section}>
    <Select label={words.visibility} value={visibility} disabled={busy} onChange={value=>{setVisibility(value as 'shared'|'private');setConfirmed(false)}} options={[{value:'shared',label:words.shared},{value:'private',label:words.private}]} />
    <Text style={styles.note}>{visibility==='shared'?words.sharedDescription:words.privateDescription}</Text>
    <Text style={styles.note}>{words.parentBoundary}</Text>
    <Text accessibilityRole="header" style={styles.subheading}>{words.members}</Text>
    {!grants.length?<Text style={styles.note}>{words.noGrants}</Text>:null}
    {grants.map(grant=><View key={grant.subjectId} style={styles.member}>
      <View style={styles.heading}><Text style={styles.memberName}>{data.members.find(person=>person.id===grant.subjectId)?.name||words.unavailableMember}</Text><CardButton label={words.removeMember} disabled={busy} onPress={()=>setGrants(current=>current.filter(item=>item.subjectId!==grant.subjectId))} /></View>
      <Select label={words.permission} value={grantLevel(grant)} disabled={busy} onChange={value=>update(grant.subjectId,{capabilities:[...levels[value as Level]]})} options={Object.keys(levels).map(value=>({value,label:words[value as Level]}))} />
      <Select label={words.expiresOptional} value={grant.expiresAt??''} disabled={busy} onChange={value=>{if(value!==grant.expiresAt)update(grant.subjectId,{expiresAt:value?new Date(Date.now()+Number(value)*3_600_000).toISOString():null})}} options={[
        {value:'',label:words.noExpiry},...(grant.expiresAt?[{value:grant.expiresAt,label:new Date(grant.expiresAt).toLocaleString()}]:[]),
        {value:'1',label:words.oneHour},{value:'24',label:words.oneDay},{value:'168',label:words.oneWeek},
      ]} />
    </View>)}
    {remaining.length?<><Select label={words.addMember} value={member} disabled={busy} onChange={setMember} options={[{value:'',label:words.chooseMember},...remaining.map(person=>({value:person.id,label:person.name||words.unavailableMember}))]} /><CardButton label={words.add} disabled={busy||!member} onPress={()=>{setGrants(current=>[...current,{subjectId:member,capabilities:[...levels.reader],expiresAt:null}]);setMember('');setConfirmed(false)}} /></>:null}
    {expansion?<Host matchContents><Switch label={words.confirmExpansion} value={confirmed} onValueChange={setConfirmed} disabled={busy} /></Host>:null}
    {error?<Text accessibilityRole="alert" style={styles.error}>{error}</Text>:null}
    <CardButton primary label={words.save} busy={busy} disabled={!changed||expansion&&!confirmed} onPress={()=>void save()} />
  </View>
}

/** An authorized continuation is an explicit choice; plain comments never spend the Owner's resources. */
export function ThreadExecutionChoice({id,value,onChange,active}:{id:string;value:string;onChange:(value:string)=>void;active:boolean}) {
  const {data,error,reload}=useApi<ThreadExecutionAccess>(`/api/resources/thread/${id}/execution`)
  const grants=data?.canContinue?data.grants.filter(grant=>grant.current&&grant.remainingComputeSeconds>=grant.maxTurnSeconds):[]
  const valid=!value||grants.some(grant=>grant.id===value)
  return <View style={styles.choice}>
    <Select label={words.sendMode} value={value} onChange={onChange} options={[
      {value:'',label:words.commentOnly},...!valid?[{value,label:words.inactiveGrant}]:[],
      ...grants.map(grant=>({value:grant.id,label:words.continueWith.replace('{model}',grant.model).replace('{minutes}',String(Math.floor(grant.remainingComputeSeconds/60)))})),
    ]} />
    <Text style={styles.note}>{!valid?words.grantUnavailable:value?words.externalCostUnknown:active?words.commentWhileRunning:words.commentHint}</Text>
    <ReadNotice error={error} hasData={Boolean(data)} label={words.executionTitle} onRetry={reload} />
  </View>
}

function ExecutionForm({threadId}:{threadId:string}) {
  const path=`/api/resources/thread/${threadId}/execution`
  const {data,error,reload}=useApi<ThreadExecutionAccess>(path)
  return <View style={styles.section}><Text accessibilityRole="header" style={styles.subheading}>{words.executionTitle}</Text><Text style={styles.note}>{words.executionDescription}</Text>
    <ReadNotice error={error} hasData={Boolean(data)} label={words.executionTitle} onRetry={reload} />
    {!data&&!error?<Spinner />:data?.canManage?<GrantForm key={threadId} data={data} path={path} saved={reload} />:null}
  </View>
}

function GrantForm({data,path,saved}:{data:ThreadExecutionAccess;path:string;saved:()=>Promise<void>}) {
  const [actorId,setActorId]=useState(''),[credentialId,setCredentialId]=useState(''),[model,setModel]=useState('')
  const [harness,setHarness]=useState('claude_code'),[minutes,setMinutes]=useState('60'),[turnMinutes,setTurnMinutes]=useState('15'),[hours,setHours]=useState('24')
  const [confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const connection=data.connections.find(item=>item.id===credentialId)
  const numbers=[Number(minutes),Number(turnMinutes),Number(hours)]
  const valid=numbers.every(value=>Number.isSafeInteger(value)&&value>0)&&numbers[0]!<=1440&&numbers[1]!<=Math.min(numbers[0]!,60)&&numbers[2]!<=720
  async function write(method:'POST'|'DELETE',body:unknown,target=path) {
    const context=apiCache.context()
    setBusy(true);setError('')
    try{await api(target,{method,body});apiCache.commit(context,()=>setConfirmed(false));await saved()}
    catch(failure){apiCache.commit(context,()=>setError(failureLine(failure)))}
    finally{apiCache.commit(context,()=>setBusy(false))}
  }
  return <>
    {data.grants.map(grant=><View key={grant.id} style={styles.member}>
      <Text style={styles.memberName}>{data.members.find(member=>member.id===grant.actorId)?.name||words.unavailableMember} · {grant.model}</Text>
      <Text style={styles.note}>{minutesLine(grant.remainingComputeSeconds)} · {grant.current?words.activeGrant:words.inactiveGrant}</Text>
      <Text style={styles.note}>{words.externalCostUnknown}</Text>
      {grant.current?<CardButton label={words.revoke} disabled={busy} onPress={()=>void write('DELETE',{grantId:grant.id},`/api/resources/thread/${grant.threadId}/execution`)} />:null}
    </View>)}
    {!data.connections.length?<Text style={styles.note}>{words.noConnections}</Text>:!data.members.length?<Text style={styles.note}>{words.noMembers}</Text>:<View style={styles.section}>
      <Select label={words.chooseMember} value={actorId} disabled={busy} onChange={value=>{setActorId(value);setConfirmed(false)}} options={[{value:'',label:words.chooseMember},...data.members.map(member=>({value:member.id,label:member.name||words.unavailableMember}))]} />
      <Select label={words.connection} value={credentialId} disabled={busy} onChange={value=>{const next=data.connections.find(item=>item.id===value);setCredentialId(value);setModel('');setHarness(next?.harnesses.includes('claude_code')?'claude_code':'codex');setConfirmed(false)}} options={[{value:'',label:words.chooseConnection},...data.connections.map(item=>({value:item.id,label:item.name||item.provider}))]} />
      {connection?<><Select label={words.model} value={model} disabled={busy} onChange={value=>{setModel(value);setConfirmed(false)}} options={[{value:'',label:words.chooseModel},...connection.models.map(value=>({value,label:value}))]} />
        <Select label={words.harness} value={harness} disabled={busy} onChange={value=>{setHarness(value);setConfirmed(false)}} options={connection.harnesses.filter(value=>value==='claude_code'||value==='codex').map(value=>({value,label:value==='claude_code'?'Claude Code':'Codex'}))} /></>:null}
      <Input label={words.totalMinutes} value={minutes} onChangeText={value=>{setMinutes(value);setConfirmed(false)}} keyboardType="number-pad" disabled={busy} />
      <Input label={words.turnMinutes} value={turnMinutes} onChangeText={value=>{setTurnMinutes(value);setConfirmed(false)}} keyboardType="number-pad" disabled={busy} />
      <Input label={words.expiryHours} value={hours} onChangeText={value=>{setHours(value);setConfirmed(false)}} keyboardType="number-pad" disabled={busy} />
      <Host matchContents><Switch label={words.executionConfirm} value={confirmed} onValueChange={setConfirmed} disabled={busy} /></Host>
      <CardButton primary label={words.authorize} busy={busy} disabled={!confirmed||!valid||!actorId||!credentialId||!model||!connection?.harnesses.includes(harness)} onPress={()=>void write('POST',{actorId,credentialId,model,harness,totalComputeSeconds:Number(minutes)*60,maxTurnSeconds:Number(turnMinutes)*60,expiresAt:new Date(Date.now()+Number(hours)*3_600_000).toISOString(),confirmExternalResourceUse:true})} />
    </View>}
    {error?<Text accessibilityRole="alert" style={styles.error}>{error}</Text>:null}
  </>
}

function Select({label,value,onChange,options,disabled}:{label:string;value:string;onChange:(value:string)=>void;options:{value:string;label:string}[];disabled?:boolean}) {
  return <View style={styles.select}><Text style={styles.label}>{label}</Text><Host matchContents><Picker selectedValue={value} onValueChange={onChange} enabled={!disabled}>{options.map(option=><Picker.Item key={option.value} value={option.value} label={option.label} />)}</Picker></Host></View>
}

const styles=StyleSheet.create({
  body:{padding:20,paddingBottom:40,gap:20},heading:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:12},
  title:{fontSize:20,fontWeight:'600',flex:1},subheading:{fontSize:17,fontWeight:'600'},section:{gap:16},
  note:{fontSize:13,lineHeight:19,color:colors.secondary},error:{fontSize:14,color:colors.danger},
  member:{gap:12,padding:16,borderRadius:16,backgroundColor:colors.bubble},memberName:{flex:1,fontSize:15,fontWeight:'600'},
  select:{gap:8},label:{fontSize:14,fontWeight:'500'},choice:{gap:8,paddingHorizontal:16,paddingVertical:8},
})
