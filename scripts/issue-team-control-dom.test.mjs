import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { Window } from 'happy-dom'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'

const window = new Window({ url: 'http://localhost/mikka/' })
for (const key of ['window','document','navigator','HTMLElement','Element','Node']) Object.defineProperty(globalThis,key,{value:key==='window'?window:window[key],configurable:true})
globalThis.IS_REACT_ACT_ENVIRONMENT=true
let currentTeam, submit, calls, choices, prompts
const team={id:'team-explicit',identifier:'TEAM',name:'Synthetic'}
window.confirm=()=>{prompts++;throw Error('Unexpected manual approval')}
mock.module('next-intl',{namedExports:{useTranslations:()=>key=>key}})
mock.module('swr',{defaultExport:key=>key==='teams'?{data:[team]}:{data:currentTeam,mutate:async value=>{currentTeam=value}},namedExports:{useSWRConfig:()=>({mutate:async()=>{}})}})
mock.module(new URL('../app/actions/teams.ts',import.meta.url).href,{namedExports:{listTeams:async()=>[team]}})
mock.module(new URL('../app/actions/team-relations.ts',import.meta.url).href,{namedExports:{getIssueTeam:async()=>currentTeam,setIssueTeam:async input=>{calls.push(input);return submit(input)}}})
const children=props=>createElement('div',null,props.children)
mock.module(new URL('../components/ui/select.tsx',import.meta.url).href,{namedExports:{
  Select:props=>createElement('select',{value:props.value,disabled:props.disabled,onChange:event=>props.onValueChange(event.target.value)},props.items.map(item=>createElement('option',{key:item.value,value:item.value},item.label))),
  SelectContent:children,SelectGroup:children,SelectItem:children,SelectTrigger:children,SelectValue:children,
}})
mock.module(new URL('../components/ui/button.tsx',import.meta.url).href,{namedExports:{Button:props=>createElement('button',{disabled:props.disabled,onClick:props.onClick},props.children)}})
const {IssueTeamControl}=await import('../components/teams/issue-team-control.tsx')
async function exercise(response) {
  currentTeam=null;calls=[];choices=[];prompts=0;submit=async()=>response
  const host=document.createElement('div');document.body.append(host)
  const root=createRoot(host)
  try {
    await act(async()=>root.render(createElement(IssueTeamControl,{issueId:'issue-a',disabled:false,onChosen:(...args)=>choices.push(args)})))
    await act(async()=>{const select=host.querySelector('select');select.value=team.id;select.dispatchEvent(new window.Event('change',{bubbles:true}))})
    assert.deepEqual(choices,[['issue-a',null]],'changing an unsaved choice invalidates earlier intent')
    await act(async()=>{host.querySelector('button').click();await new Promise(resolve=>setImmediate(resolve))})
    assert.equal(prompts,0)
    assert.deepEqual(calls,[{issueId:'issue-a',teamId:team.id,expectedTeamId:null}])
    return [...choices]
  } finally {await act(async()=>root.unmount());host.remove()}
}
test('actual team-save handler submits an explicit target once without an extra approval',async()=>{
  assert.deepEqual(await exercise({ok:true,data:team.id}),[['issue-a',null],['issue-a',team.id]])
})
test('denied team-save does not issue a successful sharing intent or prompt again',async()=>{
  assert.deepEqual(await exercise({ok:false,error:'denied'}),[['issue-a',null]])
})
