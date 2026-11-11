// MIK-2：迁移文件名检查（时间戳命名）。
// scripts/migrate.mjs 以文件名为主键记录已执行的迁移，所以：
// - 旧的 NNNN_*.sql 已经在生产执行过，冻结：不许新增、改名或修改（含 0004–0008 的历史重号）。
// - 新迁移由 migration:new 自动生成 UTC 时间戳，ID 唯一；main 上的文件保持原名和原内容。
// - 分支的新迁移可早于 main 的最新时间戳；runner 按逐文件执行台账补齐，而非使用最大时间戳。
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

// files: 当前分支的 [{name, content}]；mainFiles: main 上的文件快照（兼容旧的文件名数组）。
export function checkMigrations(files, mainFiles, legacy = LEGACY_FROZEN) {
  const problems = []
  const names = files.map((f) => f.name)
  if (new Set(names).size !== names.length) problems.push('存在重复的迁移文件名')
  const seenTs = new Map()
  for (const { name, content } of files) {
    if (!name.endsWith('.sql')) continue
    if (/^\d{4}_/.test(name)) {
      if (!(name in legacy)) problems.push(`${name}：旧的 NNNN_ 编号已冻结，新迁移请用 YYYYMMDDHHMMSS_slug.sql（UTC）`)
      else if (legacy[name] && hash(content) !== legacy[name]) problems.push(`${name}：已执行的旧迁移不能修改`)
      continue
    }
    const ts = parseTimestamp(name)
    if (!ts) { problems.push(`${name}：文件名必须是 YYYYMMDDHHMMSS_snake_case.sql，且时间合法（UTC）`); continue }
    if (seenTs.has(ts)) problems.push(`${name}：时间戳和 ${seenTs.get(ts)} 相同，请用 migration:new 重新生成未执行的迁移`)
    seenTs.set(ts, name)
  }
  for (const name of Object.keys(legacy)) {
    if (!names.includes(name)) problems.push(`${name}：已执行的旧迁移不能删除或改名`)
  }
  const current = new Map(files.map(file => [file.name, file.content]))
  for (const entry of mainFiles ?? []) {
    const { name, content } = typeof entry === 'string' ? { name: entry } : entry
    if (!current.has(name)) problems.push(`${name}：main 上的迁移不能删除或改名`)
    else if (content !== undefined && current.get(name) !== content) problems.push(`${name}：main 上的迁移不能修改，请新增修正迁移`)
  }
  return problems
}

function mainMigrations() {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  for (const ref of ['origin/main', 'FETCH_HEAD']) {
    try {
      // A stale branch has not deleted migrations added to main after it forked.
      // Freeze its inherited history; the merged tree also includes newer main files.
      const inherited = git('merge-base', ref, 'HEAD').trim()
      return {
        names: git('ls-tree', '--name-only', ref, 'drizzle/').split('\n').filter(path => path.endsWith('.sql')).map(path => path.slice('drizzle/'.length)),
        files: git('ls-tree', '--name-only', inherited, 'drizzle/').split('\n').filter(path => path.endsWith('.sql'))
          .map(path => ({ name: path.slice('drizzle/'.length), content: git('show', `${inherited}:${path}`) })),
      }
    } catch {}
    if (ref === 'origin/main') { try { git('fetch', '--depth=1', 'origin', 'main') } catch {} }
  }
  return null
}

/**
 * Every migration name that exists on any ref, not only on main.
 *
 * A working tree cannot see an ID collision on another branch. This diagnostic
 * includes locally known refs; the ordinary check rejects duplicate IDs when
 * both files appear in the same merged tree.
 *
 * `git log --all` visits every commit once and lists the .sql files it added or
 * renamed, which is one process instead of one `ls-tree` per ref (2300 refs cost
 * ~30s the other way). Adds alone are not enough: a migration that was renamed into
 * its final timestamp is never "added" under that name, so --diff-filter=A misses
 * exactly the renamed slots this check exists to find (a8f5b82f9 renumbered
 * 20261110220000_thread_modes.sql into place and A alone did not see it).
 *
 * The list is historical, so it keeps a name whose branch has since dropped it; that
 * over-reports a slot as busy rather than missing a real race, which is the safe
 * direction for a report-only check.
 */
export function allRefMigrationNames(root = process.cwd()) {
  try {
    return execFileSync('git', ['log', '--all', '--diff-filter=AR', '--name-only', '--format=', '--', 'drizzle/*.sql'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter(Boolean).map((p) => p.slice('drizzle/'.length)).filter(Boolean)
  } catch { return null }
}

/**
 * Timeslots claimed by more than one distinct filename across every ref.
 *
 * Same-timestamp files on a single branch are already rejected by checkMigrations;
 * this answers the different question of two branches racing for one slot, which no
 * single-branch check can see.
 */
export function slotCollisions(names) {
  const bySlot = new Map()
  for (const name of names) {
    if (!name.endsWith('.sql') || /^\d{4}_/.test(name)) continue
    const ts = parseTimestamp(name)
    if (!ts) continue
    const held = bySlot.get(ts) ?? []
    if (!held.includes(name)) held.push(name)
    bySlot.set(ts, held)
  }
  return [...bySlot].filter(([, held]) => held.length > 1).map(([slot, held]) => ({ slot, names: held.sort() }))
}

/**
 * Collisions that are still a race: every name at that slot is absent from main.
 *
 * A slot where one file already merged is settled — the other file is either an
 * abandoned branch or a duplicate that will fail its own check — and failing CI on
 * it would punish every unrelated pull request. Only two unmerged files claiming one
 * slot is a live race, and that is what --enforce rejects.
 */
export function liveCollisions(collisions, mainFiles) {
  const merged = new Set(mainFiles ?? [])
  return collisions.filter(({ names }) => names.every((name) => !merged.has(name)))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = new URL('../drizzle/', import.meta.url)
  const files = readdirSync(dir).filter((n) => n.endsWith('.sql')).map((name) => ({ name, content: readFileSync(new URL(name, dir), 'utf8') }))
  const main = mainMigrations()
  if (!main) console.warn('migrations: 拿不到 origin/main，跳过 main 文件内容比对；保留格式、重复 ID 和旧迁移检查')
  const problems = checkMigrations(files, main?.files)
  const localNames = new Set(files.map(file => file.name))
  // Include post-fork main names even when this stale branch has not merged
  // them. Identical filenames are one migration; distinct names cannot share an ID.
  for (const { slot, names } of slotCollisions([...localNames, ...(main?.names ?? [])])) {
    if (names.some(name => localNames.has(name)) && names.some(name => !localNames.has(name))) {
      problems.push(`main 与当前分支的迁移 ID ${slot} 冲突：${names.join('、')}，请用 migration:new 重新生成未执行的迁移`)
    }
  }

  // --all-refs: report slots that another branch already claimed. Report-only by
  // default because in-flight collisions are not this branch's fault and must not
  // turn its CI red; --enforce makes it fail for a release gate. `--all-refs` scans
  // locally-known refs, so fetch first to see the newest branches.
  if (process.argv.includes('--all-refs')) {
    const names = allRefMigrationNames()
    if (!names) console.warn('migrations: --all-refs 拿不到 git 历史，跳过跨分支检查')
    else {
      const collisions = slotCollisions(names)
      const mine = new Set(files.map((f) => f.name))
      const mainNames = main?.names ?? null
      const merged = new Set(mainNames ?? [])
      const live = liveCollisions(collisions, mainNames)
      // Every collision is listed, this branch's own marked, because a race that
      // does not touch this branch today is still why a slot is not free tomorrow.
      if (collisions.length) {
        console.error(`migrations: --all-refs 在历史上发现 ${collisions.length} 个 slot 被多个文件名争用（✓ 本分支占用，! 仍在飞）\n${collisions.map(({ slot, names: held }) => `  - ${slot}：${held.map((n) => `${live.some((l) => l.slot === slot) ? '!' : ' '}${mine.has(n) ? '✓' : ' '}${n}${merged.has(n) ? '（已在 main）' : ''}`).join(' / ')}`).join('\n')}`)
      } else console.log('migrations: --all-refs 没有发现跨分支 slot 争用')
      if (live.length) {
        console.error(`migrations: --all-refs ${live.length} 个 slot 上所有文件名都还没进 main，是真争用`)
        // --enforce judges this branch only: failing on a race between two unrelated
        // branches would red CI for a pull request that has nothing wrong with it.
        const mineLive = live.filter(({ names: held }) => held.some((n) => mine.has(n)))
        if (mineLive.length) {
          console.error(`migrations: --all-refs 本分支占用的 ${mineLive.length} 个 slot 仍在飞：${mineLive.map((c) => c.slot).join('、')}，请用 migration:new 重新生成未执行的迁移`)
          if (process.argv.includes('--enforce')) process.exit(1)
        } else console.log('migrations: --all-refs 本分支占用的 slot 不在这些争用里')
      } else console.log(`migrations: --all-refs 扫了 ${new Set(names).size} 个历史迁移名，没有仍在飞的 slot 争用`)
    }
  }

  if (problems.length) {
    console.error(`migrations: ${problems.length} 个问题\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    process.exit(1)
  }
  console.log(`migrations: ${files.length} 个迁移文件检查通过`)
}
