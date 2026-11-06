// Run with the existing authorized workload identity. Defaults to read-only.
// node --import ./scripts/server-test.mjs --import tsx scripts/ops/remove-demo-devices.ts [--apply]
import { removeDemoDevices } from '../../lib/demo-device-cleanup'
import { pool } from '../../lib/db'

try {
  if (process.argv.slice(2).some(argument => argument !== '--apply')) throw new Error('Only --apply is supported')
  console.log(JSON.stringify(await removeDemoDevices(process.argv.includes('--apply'))))
} finally { await pool.end() }
