import assert from 'node:assert/strict'
import test from 'node:test'
import { timingSummary } from './summary.mjs'
test('timings separate queue-inclusive wall time from completed runner consumption', () => {
  const summary=timingSummary({id:7,html_url:'https://example.invalid/7',created_at:'2026-11-08T00:00:00Z'},[
    {name:'unit',status:'completed',conclusion:'success',started_at:'2026-11-08T00:01:00Z',completed_at:'2026-11-08T00:03:00Z'},
    {name:'DB',status:'completed',conclusion:'failure',started_at:'2026-11-08T00:01:00Z',completed_at:'2026-11-08T00:02:00Z'},
    {name:'unselected',status:'completed',conclusion:'skipped',started_at:'2026-11-08T00:00:00Z',completed_at:'2026-11-08T00:04:00Z'},
    {name:'gate',status:'in_progress',conclusion:null,started_at:'2026-11-08T00:03:00Z'},
  ],Date.parse('2026-11-08T00:04:00Z'))
  assert(summary.includes('240 s elapsed including queue; 3.00 completed runner-minutes'))
  assert(summary.includes('| DB | failure | 60 |'))
  assert(!summary.includes('| unselected |'))
  assert(!summary.includes('| gate |'))
})
