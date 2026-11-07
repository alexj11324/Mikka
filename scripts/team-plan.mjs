#!/usr/bin/env node
// Operator-only: node --import tsx scripts/team-plan.mjs [--apply] < grant.json
// Existing DATABASE_URL authority is required. Dry-run is the default.
import { Pool } from 'pg'
import { directDatabaseURL } from './postgres-connection.mjs'
import { provisionWorkspacePlan } from '../lib/governance/provisioning.ts'

async function main() {
  const args = process.argv.slice(2)
  if (args.some(arg => arg !== '--apply') || args.length > 1) throw new Error('team_plan_invalid_arguments')
  if (!process.env.DATABASE_URL) throw new Error('team_plan_database_required')
  let input = ''
  for await (const chunk of process.stdin) {
    input += chunk
    if (Buffer.byteLength(input) > 16_384) throw new Error('team_plan_input_too_large')
  }
  const pool = new Pool({ connectionString: directDatabaseURL(process.env.DATABASE_URL), max: 1, connectionTimeoutMillis: 10_000 })
  try { console.log(JSON.stringify(await provisionWorkspacePlan(pool, JSON.parse(input), { apply: args.includes('--apply') }))) }
  finally { await pool.end() }
}
main().catch(error => {
  // pg and validation messages can include connection values or input; never print them.
  console.error('team_plan_failed', { code: error?.code === 'governance_denied' ? error.code : 'invalid_operation', detail: error?.code === 'governance_denied' ? error.detail : undefined })
  process.exitCode = 1
})
