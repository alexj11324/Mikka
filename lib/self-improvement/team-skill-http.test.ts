import assert from 'node:assert/strict'
import test from 'node:test'
import { createTeamSkillHandler } from './team-skill-http'
import { ImprovementError } from './contract'

const workspaceId='10000000-0000-4000-8000-000000000001'
const versionId='10000000-0000-4000-8000-000000000002'
const runId='10000000-0000-4000-8000-000000000003'
test('team API uses authenticated scope, exact origin and bounded strict commands',async()=>{
  const calls:unknown[]=[]
  const handle=createTeamSkillHandler({principal:async()=> 'member',store:{
    register:async(scope,input)=>{calls.push({scope,input});return {} as never},
    read:async(scope,id)=>{calls.push({scope,versionId:id});return {} as never},
    review:async(scope,input,operation)=>{calls.push({scope,input,operation});return {} as never},
    list:async()=>[],
  },assignments:{selectTeam:async(userId,id,version)=>{calls.push({userId,runId:id,versionId:version});return {} as never}}})
  const send=(input:unknown,origin='http://localhost')=>handle(new Request('http://localhost/team-skills',{
    method:'POST',headers:{origin},body:JSON.stringify(input),
  }),workspaceId)
  const command={operation:'select',versionId,runId}
  assert.equal((await send(command,'https://foreign.example')).status,403)
  assert.equal((await send({...command,userId:'forged'})).status,422)
  assert.equal((await send({...command,padding:'x'.repeat(128_000)})).status,413)
  assert.equal(calls.length,0)
  const result=await send(command)
  assert.equal(result.status,200)
  assert.equal(result.headers.get('cache-control'),'private, no-store')
  assert.deepEqual(calls,[{scope:{workspaceId,userId:'member'},versionId},{userId:'member',runId,versionId}])
})
test('team API cannot select after the namespace-approved read rejects and does not disclose a foreign version',async()=>{
  let selected=false
  const store={register:async()=>({} as never),list:async()=>[],review:async()=>({} as never),
    read:async()=>{throw new ImprovementError('notFound')}}
  const assignments={selectTeam:async()=>{selected=true;return {} as never}}
  const handle=createTeamSkillHandler({principal:async()=> 'member',store,assignments})
  const result=await handle(new Request('http://localhost/team-skills',{method:'POST',headers:{origin:'http://localhost'},
    body:JSON.stringify({operation:'select',versionId,runId})}),workspaceId)
  assert.equal(result.status,404);assert.deepEqual(await result.json(),{error:'notFound'});assert.equal(selected,false)
  const anonymous=createTeamSkillHandler({principal:async()=>null,store,assignments})
  assert.equal((await anonymous(new Request('http://localhost/team-skills'),workspaceId)).status,401)
})
