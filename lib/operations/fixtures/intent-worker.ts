import { Pool } from 'pg'
import { createActionIntents } from '../action-intents'
const pool = new Pool({ connectionString: process.env.INTENT_FIXTURE_URL })
const input = JSON.parse(process.env.INTENT_FIXTURE_INPUT!)
void createActionIntents(pool).persistBatch(input.owner, input.context, input.calls).then(() => {
  process.send?.('persisted')
  setInterval(() => {}, 1000)
}).catch(() => { process.exitCode = 1; void pool.end() })
