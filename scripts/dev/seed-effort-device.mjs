// Dev only: gives a local user a fake, always-online device whose Claude Code
// harness reports models, effort levels and permission modes, so the Agent
// settings can be reviewed without a running daemon.
//   node scripts/dev/seed-effort-device.mjs [--email you@example.com]          add or refresh
//   node scripts/dev/seed-effort-device.mjs [--email you@example.com] --clean  remove it
// The email defaults to MIKKA_TEST_EMAIL. Refuses any database not on this machine.
import { createHash } from 'node:crypto'
import { Pool } from 'pg'

const args = process.argv.slice(2)
const clean = args.includes('--clean')
const emailAt = args.indexOf('--email')
const email = emailAt >= 0 ? args[emailAt + 1] : process.env.MIKKA_TEST_EMAIL
if (!email) throw new Error('Pass --email or set MIKKA_TEST_EMAIL.')
if (process.env.VERCEL_ENV) throw new Error('Refusing to run on Vercel.')
const url = process.env.MIKKA_DATABASE_URL
if (!url) throw new Error('MIKKA_DATABASE_URL is not set.')
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Refusing: MIKKA_DATABASE_URL is not a local database.')

const harnesses = [{
  harness: 'claude_code', installed: true, version: '2.1.308 (seed)',
  models: [
    { value: 'default', displayName: 'Default (recommended)', efforts: ['low', 'medium', 'high', 'max'] },
    { value: 'opus', displayName: 'Opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'sonnet', displayName: 'Sonnet', efforts: ['low', 'medium', 'high', 'max'] },
    { value: 'haiku', displayName: 'Haiku', efforts: [] },
  ],
  permissionModes: ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'],
}]

const pool = new Pool({ connectionString: url, max: 1 })
try {
  const { rows: [user] } = await pool.query('SELECT id FROM "user" WHERE email = $1', [email])
  if (!user) throw new Error(`No user with email ${email}; nothing written.`)
  const h = createHash('sha256').update(`${user.id}:seed-effort-device`).digest('hex')
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
  if (clean) {
    // Agents pinned to it fall back to automatic placement.
    await pool.query('UPDATE agents SET "deviceId" = NULL WHERE "deviceId" = $1', [id])
    const { rowCount } = await pool.query('DELETE FROM devices WHERE id = $1 AND "ownerId" = $2', [id, user.id])
    console.log(rowCount ? `Removed the seed device for ${email}.` : `No seed device for ${email}.`)
  } else {
    // lastSeenAt is a year ahead so the device stays online until --clean.
    await pool.query(
      `INSERT INTO devices (id, "ownerId", name, hostname, platform, arch, "daemonVersion", harnesses, "lastSeenAt")
       VALUES ($1, $2, 'Seed Mac (dev)', 'seed-mac.local', 'darwin', 'arm64', 'seed', $3, now() + interval '1 year')
       ON CONFLICT (id) DO UPDATE SET harnesses = EXCLUDED.harnesses, "lastSeenAt" = EXCLUDED."lastSeenAt", enabled = true, "updatedAt" = now()`,
      [id, user.id, JSON.stringify(harnesses)])
    console.log(`Seed device ready for ${email}: Seed Mac (dev), Claude Code with ${harnesses[0].models.length} models.`)
  }
} finally {
  await pool.end()
}
