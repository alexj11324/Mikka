import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatItems, eventPrompt, promptMessages, type StoredMessage } from './context'
import { eventsForInbox, isolateTaskRequest, ruleTier, tierFromDecision, triageQuestions, triageState } from './triage'
import { briefingEvent } from '@/lib/coordinator-events'

const run = (payload: Record<string, unknown>) => ({ kind: 'run_finished' as const, payload: { stopReason: 'submitted', ...payload } })

test('machine-selected requests get separate turns in inbox order', () => {
  const normal = { kind: 'user_message', payload: { text: 'hello' } }
  const first = { kind: 'user_message', payload: { taskDestination: { kind: 'cloud' } } }
  const second = { kind: 'user_message', payload: { taskDestination: { kind: 'device', deviceId: 'device' } } }
  assert.deepEqual(isolateTaskRequest([normal, first, second]), [normal])
  assert.deepEqual(isolateTaskRequest([first, second, normal]), [first])
  assert.deepEqual(isolateTaskRequest([second, normal]), [second])
  assert.deepEqual(isolateTaskRequest([normal]), [normal])
})

test('only direct user delivery has a transport tier; every runtime event needs model judgment', () => {
  assert.equal(ruleTier({ kind:'user_message',payload:{text:'hi'} }), 'attention')
  for (const kind of ['issue_done','run_retried','run_finished','run_question','run_blocked','run_report','daily_briefing','matter_handoff','artifact_submitted','action_decided'] as const) {
    for (const status of ['failed','cancelled','stopped','succeeded']) assert.equal(ruleTier({kind,payload:{status}}), null)
  }

})
test('triage projects observed state separately from untrusted claims and asks for a direct choice', () => {
  const state=triageState(run({status:'succeeded',summary:'Done'}))
  assert.equal(JSON.parse(state.untrustedEventPayload).summary,'Done')
  assert.equal(JSON.parse(state.hostObservation).observedRun,null)
  assert.equal(triageQuestions(run({}))[0].type,'choice')
  assert.equal(tierFromDecision({type:'choice',name:'tier',choice:'result'}),'result')
  assert.equal(tierFromDecision({type:'predicate',name:'tier',probability:0.99}),null)
  assert.equal(tierFromDecision(undefined),null)
})

test('the tier reaches the Coordinator but not the chat', () => {
  const text = eventPrompt({ kind: 'run_finished', issueId: null, runId: 'r1', payload: { status: 'failed', stopReason: 'error' }, tier: 'attention' })
  assert.match(text, /\nTriage: this needs the person/)
  const [item] = chatItems([{ position: 1, createdAt: new Date(), message: { role: 'user', content: text } }])
  assert.equal(item.text, '[Event] Run r1 ended with status failed (error).')
  assert.doesNotMatch(eventPrompt({ kind: 'issue_done', issueId: 'i1', runId: null, payload: { title: 'Login', previousStatus: 'review' }, tier: 'result' }), /Triage/)
})

test('a waking message reaches a batch ahead of an older background backlog', () => {
  const background = Array.from({ length: 500 }, (_, index) => ({ id: `done-${index}`, createdAt: new Date(index) }))
  const message = { id: 'message', createdAt: new Date(500) }
  const batch = eventsForInbox([message], background, 50)

  assert.equal(batch.length, 50)
  assert.ok(batch.includes(message))
  assert.deepEqual(batch, [...batch].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()))
})

test('worker questions and blockers are not automatically escalated to a person', () => {
  for(const kind of ['run_question','run_blocked','run_report'] as const) assert.equal(ruleTier({kind,payload:{text:'',reason:'blocked'}}),null)
  assert.match(triageQuestions(run({}))[0].instructions,/does not automatically need a person/)
})

test('a worker question tells the Coordinator to relay the answer', () => {
  const text = eventPrompt({ kind: 'run_question', issueId: null, runId: 'r2', payload: { question: 'Keep v1?', options: ['Yes', 'No'] }, tier: 'attention' })
  assert.match(text, /asks the person: Keep v1\?\nOptions: Yes \/ No[\s\S]*send_to_run/)
})

test('the morning briefing is pushed to the person once a day', () => {
  const event = briefingEvent({ userId: 'u1', localDate: '2026-10-27', kind: 'daily', total: 4, counts: { gmail: 3, linear: 1 } }, [
    { suggestionId: 's1', source: 'linear', action: 'handle', title: 'Fix login', actor: 'Dana', url: 'https://linear.app/x/issue/MIK-9', required: true },
    { suggestionId: 's2', source: 'gmail', action: 'reply', title: 'Thursday agenda', actor: null, url: null, required: false },
  ])
  assert.equal(event.dedupeKey, 'daily_briefing:u1:2026-10-27:daily')
  assert.notEqual(briefingEvent({ userId: 'u1', localDate: '2026-10-27', kind: 'first', total: 1, counts: {} }, []).dedupeKey, event.dedupeKey)
  const tier = 'attention' as const // This projection fixture supplies a completed model decision.
  const prompt = eventPrompt({ ...event, tier })
  assert.match(prompt, /^\[Event\] It is 08:00 for the person: their morning briefing for 2026-10-27\. 4 item\(s\)/)
  assert.match(prompt, /gmail 3, linear 1/)
  assert.match(prompt, /- linear · handle · assigned to them: "Fix login" from Dana \(https:\/\/linear\.app\/x\/issue\/MIK-9\)/)
  assert.match(prompt, /Do not act until they say so/)
  assert.match(prompt, /secretary/)
  assert.match(prompt, /早上好，Alex。今天有 4 件事/)
  assert.match(prompt, /one message/)
  assert.doesNotMatch(prompt, /The person's name/)
  assert.match(eventPrompt({ ...briefingEvent({ userId: 'u1', localDate: '2026-10-27', kind: 'daily', total: 1, counts: {} }, [], 'Alex Jiang'), tier }), /The person's name: Alex Jiang\./)
  assert.deepEqual((event.payload.items as { suggestionId: string }[]).map(item => item.suggestionId), ['s1', 's2'])
  for (const kind of ['daily', 'first'] as const) {
    const content = eventPrompt({ ...briefingEvent({ userId: 'u1', localDate: '2026-10-27', kind, total: 4, counts: { gmail: 3, linear: 1 } }, event.payload.items as Parameters<typeof briefingEvent>[1]), tier })
    const rows: (StoredMessage & { createdAt: Date; pending?: true })[] = [
      { position: 1, createdAt: new Date(0), message: { role: 'assistant', content: 'Yesterday’s reply.' } },
      { position: 2, createdAt: new Date(1), pending: true, message: { role: 'user', content } },
    ]
    assert.equal(chatItems(rows).length, 1, 'pending briefing instructions stay hidden')
    delete rows[1].pending
    rows.push({ position: 3, createdAt: new Date(2), message: { role: 'assistant', content: 'Good morning. Four things need your attention.' } })
    assert.deepEqual(chatItems(rows).map(item => [item.from, item.text]), [
      ['coordinator', 'Yesterday’s reply.'],
      ['coordinator', 'Good morning. Four things need your attention.'],
    ])
    assert.doesNotMatch(JSON.stringify(chatItems(rows)), /Kevin|secretary|Triage:|Write the briefing/)
    assert.ok(promptMessages(null, rows).some(message => message.role === 'user' && typeof message.content === 'string' && JSON.parse(message.content).untrustedData?.content === content), 'the model still receives briefing instructions')
  }
})
