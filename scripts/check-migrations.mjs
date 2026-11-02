// MIK-2：迁移文件名检查（时间戳命名）。
// scripts/migrate.mjs 以文件名为主键记录已执行的迁移，所以：
// - 旧的 NNNN_*.sql 已经在生产执行过，冻结：不许新增、改名或修改（含 0004–0008 的历史重号）。
// - 新迁移一律 YYYYMMDDHHMMSS_slug.sql（UTC），时间戳必须合法、晚于 main 上最新的迁移、文件名唯一。
//   时间戳由协调者派活时分配（docs/dev-workflow.md § 6），不要自己挑。
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

// 冻结的旧迁移：文件名 -> 内容 sha256 前 12 位。改动这些文件会让生产状态和仓库不一致。
export const LEGACY_FROZEN = {
  '0001_agents_devices.sql': 'ab8fd9841ef4',
  '0002_device_enabled.sql': '8301f9c5c0b2',
  '0003_agents_columns.sql': '63e6f68897d7',
  '0004_linear_sync.sql': '6929eb77de66',
  '0004_mikka_workspace_tables.sql': '36f4344dc917',
  '0004_telegram_chat.sql': '16d98249c0fc',
  '0005_linear_sync_retry_and_comment_keys.sql': '608b59709b28',
  '0005_mikka_issue_metadata.sql': '3984dadc1252',
  '0006_linear_comment_authorship.sql': '625cfad882ad',
  '0006_workspace_tables.sql': '5a9a90201e05',
  '0007_coordinator_events.sql': '7492fa8394f0',
  '0007_linear_description_snapshot.sql': '3212fbfaa18d',
  '0008_coordinator_sessions.sql': '780be522b698',
  '0008_linear_mikka_issue_metadata.sql': '308682af4f62',
  '0009_oauth_provider.sql': 'f48b4a2ccb57',
  '0010_coordinator_session_error.sql': '231a1650f400',
  '0011_coordinator_event_tier.sql': '39cee0717d46',
  '0012_run_tokens.sql': '50677d70b2ba',
  '0014_workspace_teams.sql': 'ebde945d5cfc',
}

const TIMESTAMP = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_[a-z0-9_]+\.sql$/

export function parseTimestamp(name) {
  const m = TIMESTAMP.exec(name)
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number)
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s))
  const valid =
    y >= 2026 && date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d && date.getUTCHours() === h && date.getUTCMinutes() === mi && date.getUTCSeconds() === s
  return valid ? name.slice(0, 14) : null
}

export const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12)

// files: 当前分支的 [{name, content}]；mainFiles: main 上的文件名数组（拿不到时为 null）
export function checkMigrations(files, mainFiles, legacy = LEGACY_FROZEN) {
  const problems = []
  const names = files.map((f) => f.name)
  if (new Set(names).size !== names.length) problems.push('存在重复的迁移文件名')
  const seenTs = new Map()
  const mainSet = new Set(mainFiles ?? [])
  const mainLatest = (mainFiles ?? []).map(parseTimestamp).filter(Boolean).sort().at(-1) ?? ''
  for (const { name, content } of files) {
    if (!name.endsWith('.sql')) continue
    if (/^\d{4}_/.test(name)) {
      if (!(name in legacy)) problems.push(`${name}：旧的 NNNN_ 编号已冻结，新迁移请用 YYYYMMDDHHMMSS_slug.sql（UTC）`)
      else if (legacy[name] && hash(content) !== legacy[name]) problems.push(`${name}：已执行的旧迁移不能修改`)
      continue
    }
    const ts = parseTimestamp(name)
    if (!ts) { problems.push(`${name}：文件名必须是 YYYYMMDDHHMMSS_snake_case.sql，且时间合法（UTC）`); continue }
    if (seenTs.has(ts)) problems.push(`${name}：时间戳和 ${seenTs.get(ts)} 相同，请换一个时间戳`)
    seenTs.set(ts, name)
    if (mainFiles && !mainSet.has(name) && ts <= mainLatest) {
      problems.push(`${name}：时间戳必须晚于 main 上最新的迁移 ${mainLatest}，请向协调者要一个新的时间戳（docs/dev-workflow.md § 6）`)
    }
  }
  for (const name of Object.keys(legacy)) {
    if (!names.includes(name)) problems.push(`${name}：已执行的旧迁移不能删除或改名`)
  }
  return problems
}

function mainMigrationNames() {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  for (const ref of ['origin/main', 'FETCH_HEAD']) {
    try { return git('ls-tree', '--name-only', ref, 'drizzle/').split('\n').filter(Boolean).map((p) => p.slice('drizzle/'.length)) } catch {}
    if (ref === 'origin/main') { try { git('fetch', '--depth=1', 'origin', 'main') } catch {} }
  }
  return null
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = new URL('../drizzle/', import.meta.url)
  const files = readdirSync(dir).filter((n) => n.endsWith('.sql')).map((name) => ({ name, content: readFileSync(new URL(name, dir), 'utf8') }))
  const mainFiles = mainMigrationNames()
  if (!mainFiles) console.warn('migrations: 拿不到 origin/main，跳过「晚于 main 最新迁移」这一项')
  const problems = checkMigrations(files, mainFiles)
  if (problems.length) {
    console.error(`migrations: ${problems.length} 个问题\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    process.exit(1)
  }
  console.log(`migrations: ${files.length} 个迁移文件检查通过`)
}
