import { deliverWorkspaceAudits } from '../../lib/audit/delivery'
import { pool } from '../../lib/db'
import { workspacePool } from '../../lib/workspace-db'
async function main() {
  for (const value of [process.env.MIKKA_DATABASE_URL, process.env.DATABASE_URL]) {
    const target = new URL(value ?? '')
    if (target.hostname !== '127.0.0.1' || !target.pathname.endsWith('_e2e') || target.search || target.hash) throw new Error('Audit replay fixture requires isolated loopback databases')
  }
  try { process.stdout.write(JSON.stringify(await deliverWorkspaceAudits())) }
  finally { await Promise.all([pool.end(), workspacePool.end()]) }
}
void main().catch(() => { process.stderr.write('Audit replay fixture failed'); process.exitCode = 1 })
