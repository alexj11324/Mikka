import { githubPullRequestKey } from '../../lib/issue-metadata'
import { taskPullConversations } from '../../lib/task-work-pulls'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Window } from 'happy-dom'
import { IntlProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import type { FactoryActivityView } from '../../lib/factory/activity'
import type { IssueThread } from '../../lib/issue-threads'
import { TaskWorkSection } from './task-work-section'

const messages = JSON.parse(readFileSync(new URL('../../messages/en.json',import.meta.url),'utf8'))
test('work shows the admitted conversation, one PR and the current progress; other owners have no navigation or model', () => {
  const at = new Date('2026-11-12T12:00:00Z')
  const base = { status:'succeeded', stopping:false, createdAt:at, finishedAt:at, question:null, attempts:[], continuation:null }
  const mine = { ...base, id:'r1', rootRunId:'r1', latestRunId:'r1', ownedByCurrentUser:true, ownerName:'Owner',
    detail:{ name:'Analyze the release', agentName:'My agent', harness:'codex', observedModel:'gpt-example', summary:'Reviewed the release.' } }
  const restricted = { ...base, id:'r2', rootRunId:'r2', latestRunId:'r2', ownedByCurrentUser:false, ownerName:'A colleague', detail:null }
  const url='https://github.com/example/repo/pull/5'
  const gate=(id:string,stage:string,revision:number)=>({id:'gate:f:'+id,kind:'factory_gate',sourceId:id,at:at.toISOString(),runId:'r1',attemptId:'a',candidateId:null,factoryTaskId:'f',stage,status:'running',revision})
  const factory = { task:{ id:'f',pullRequest:{url,state:'open'} }, events:[gate('old','execute',1),gate('new','verify',2)],artifacts:[{kind:'pull_request',url,runId:'r1',state:'merged'}] } as unknown as FactoryActivityView
  const html=renderToStaticMarkup(<IntlProvider locale="en" messages={messages} timeZone="UTC">
    <TaskWorkSection threads={[mine, restricted] as IssueThread[]} pulls={[{url,title:'Release review',state:'merged'}]} factory={factory} open={()=>{}}/>
  </IntlProvider>)
  assert.match(html,/Analyze the release/)
  const pull = html.match(/<a\b[^>]*>[\s\S]*?<\/a>/)?.[0] ?? ''
  assert.match(pull,/Analyze the release/)
  assert.match(pull,/My agent · gpt-example · Merged/)
  assert.match(pull,/Reviewed the release./)
  assert.match(html,/Reviewed the release/)
  assert.match(html,/A colleague/)
  const { document } = new Window()
  document.body.innerHTML = html
  const navigation = [...document.querySelectorAll('button:not([data-slot="collapsible-trigger"])')]
  assert.equal(navigation.length, 1)
  assert.match(navigation[0].textContent ?? '', /Analyze the release/)
  assert.ok(navigation.every(button => !button.textContent?.includes('A colleague')))
  assert.equal((html.match(/href="https:\/\/github.com\/example\/repo\/pull\/5"/g) ?? []).length,1)
  const progress = document.querySelectorAll('button[data-slot="collapsible-trigger"]')
  assert.equal(progress.length, 1)
  assert.equal(progress[0].getAttribute('aria-expanded'), 'false')
  assert.match(progress[0].textContent ?? '', /Verification/)
})

test('published PR sources use the authorized conversation root for continuations and omit inaccessible runs', () => {
  const visible = { id: 'root', detail: { name: 'Visible' }, attempts: [{ runId: 'continued' }] }
  const restricted = { id: 'restricted', detail: null, attempts: [{ runId: 'private' }] }
  const pull = 'https://github.com/Example/Repo/pull/5'
  const other = 'https://github.com/example/repo/pull/6'
  const publication = (url: string, runId: string) => ({ kind: 'pull_request', url, runId })
  const factory = { artifacts: [publication(pull, 'continued'), publication(pull.toLowerCase(), 'private'),
    publication(other, 'restricted'), publication(other, 'missing')] } as unknown as FactoryActivityView
  const sources = taskPullConversations([visible, restricted] as unknown as IssueThread[], factory)
  assert.equal(sources.get(githubPullRequestKey(pull.toLowerCase()))?.id, 'root')
  assert.equal(sources.has(githubPullRequestKey(other)), false)
})
