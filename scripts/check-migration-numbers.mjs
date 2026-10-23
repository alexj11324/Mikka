// MIK-2: 每个 drizzle/*.sql 迁移必须有唯一的 4 位编号前缀。
// scripts/migrate.mjs 按文件名记录已执行的迁移，所以已上线的重号文件不能改名
// （改名会让生产库重新执行一遍）。下面的历史重号只做豁免，新文件一律不允许重号。
import { readdirSync } from 'node:fs'

const legacyDuplicateFiles = new Set([
  '0004_linear_sync.sql',
  '0004_mikka_workspace_tables.sql',
  '0004_telegram_chat.sql',
  '0005_linear_sync_retry_and_comment_keys.sql',
  '0005_mikka_issue_metadata.sql',
  '0006_linear_comment_authorship.sql',
  '0006_workspace_tables.sql',
  '0007_coordinator_events.sql',
  '0007_linear_description_snapshot.sql',
  '0008_coordinator_sessions.sql',
  '0008_linear_mikka_issue_metadata.sql',
])

const dir = new URL('../drizzle/', import.meta.url)
const files = readdirSync(dir).filter((name) => name.endsWith('.sql'))
const byNumber = new Map()
const problems = []
for (const name of files) {
  const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(name)
  if (!match) { problems.push(`${name}: 文件名必须是 NNNN_snake_case.sql`); continue }
  byNumber.set(match[1], [...(byNumber.get(match[1]) ?? []), name])
}
for (const [number, names] of byNumber) {
  const unexpected = names.filter((name) => !legacyDuplicateFiles.has(name))
  if (names.length > 1 && unexpected.length > 0) {
    problems.push(`编号 ${number} 重复：${names.join('、')}。请改用下一个未占用的编号。`)
  }
}
if (problems.length) {
  console.error(`migration numbers: ${problems.length} 个问题\n${problems.map((p) => `  - ${p}`).join('\n')}`)
  process.exit(1)
}
console.log(`migration numbers: ${files.length} 个迁移文件编号检查通过`)
