// Run with the existing authorized workload identity. Defaults to read-only.
// node --import ./scripts/server-test.mjs --import tsx scripts/ops/remove-demo-devices.ts [--apply]
import { removeDemoDevices } from '../../lib/demo-device-cleanup'
import { pool } from '../../lib/db'
import { causeFields } from '@mikka/protocol/coded-error'

try {
  if (process.argv.slice(2).some(argument => argument !== '--apply')) throw new Error('Only --apply is supported')
  console.log(JSON.stringify(await removeDemoDevices(process.argv.includes('--apply'))))
} catch (error) {
  console.error(JSON.stringify({ code: 'demo_cleanup_failed', causes: causeFields(error) }))
  process.exitCode = 1
} finally { await pool.end() }
