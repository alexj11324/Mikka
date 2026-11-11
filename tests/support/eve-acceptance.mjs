export const eveHeaders = { 'content-type': 'application/x-ndjson', 'x-eve-stream-format': 'ndjson', 'x-eve-stream-version': '27' }
export const nativeCall = (callId, input, output, error) => [
  { type: 'call.requested', scope: { turnId: 'turn_fixture' }, data: { callId, owner: { turnId: 'turn_fixture' }, capability: { kind: 'tool', name: 'dispatch_run' }, input } },
  { type: 'call.settled', scope: { turnId: 'turn_fixture' }, data: { callId, outcome: error ? 'failed' : 'completed', ...(error ? { error: { code: error, message: 'Synthetic failure' } } : { output }) } },
]
export function eveResponse(facts, headers = {}) {
  return new Response(facts.map(fact => JSON.stringify({ at: '2026-11-11T00:00:00.000Z', facts: [fact] })).join('\n') + '\n', { headers: { ...eveHeaders, ...headers } })
}
