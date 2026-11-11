import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { filterAffected } from 'nx/src/project-graph/affected/affected-project-graph.js'
import { buildGraph, dbId, taskId } from './graph.mjs'
import { isSelfHostedBackendInput } from './self-hosted-requirements.mjs'
import { isDocsOnly } from '../ci-docs-only.mjs'
import tasks from './tasks.json' with { type: 'json' }

export const GLOBAL = /^(?:\.github\/(?!workflows\/README\.md$)|scripts\/|tests\/(?:helpers|support)\/|patches\/|packages\/(?:config|protocol|subscription-worker)\/|services\/|cloudflare\/|(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|nx\.json|[^/]*config[^/]*|[^/]*lock[^/]*|Dockerfile|docker-compose[^/]*|\.dockerignore|\.npmrc)$|lib\/(?:db(?:\/|\.)|auth|api-auth|fresh-session|credentials\/|secrets\/|permissions|.*authorization|.*tenant|.*scope))/
// Keep the expression readable without a trailing whitespace token.
const globalPath = file => !isDocsOnly([file]) && (GLOBAL.test(file) || /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json)$/.test(file))
export function area(file) {
  if (file.startsWith('apps/mobile/')) return 'mobile'
  if (file.startsWith('apps/desktop/')) return 'desktop'
  if (file.startsWith('packages/daemon/')) return 'daemon'
  if (file.startsWith('packages/subscription-worker/')) return 'e2b/runtime'
  if (file.startsWith('packages/')) return 'protocol/shared'
  if (/^(?:components|hooks|i18n|messages|public|apps\/frontend)\/|^app\/(?:\[locale\]|fonts|globals)/.test(file)) return 'frontend/web'
  if (/^(?:lib|app|apps\/api)\//.test(file)) return 'api/factory/coordinator'
  if (file.startsWith('drizzle/')) return 'database/migrations'
  if (/^(?:Dockerfile|docker-compose|tests\/self-hosted)/.test(file)) return 'self-hosted/image'
  if (file.startsWith('scripts/e2b/')) return 'e2b/runtime'
  if (globalPath(file)) return 'ci/release/security'
  if (isDocsOnly([file])) return 'docs-only'
  return 'unknown'
}
export function diffRange(env, event) {
  if (env.GITHUB_EVENT_NAME === 'pull_request') return [event.pull_request?.base?.sha, event.pull_request?.head?.sha]
  if (env.GITHUB_EVENT_NAME === 'merge_group') return [event.merge_group?.base_sha, event.merge_group?.head_sha]
  if (env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === 'refs/heads/main') return [event.before, event.after]
  return [] // Manual, nightly, tag and unsupported events always run all checks.
}
export async function select(plan, changes, { force = false } = {}) {
  const files = changes.map(c => c.file)
  const areas = [...new Set(files.map(area))].sort()
  const reasons = []
  if (force || !files.length) reasons.push('full integration or no trustworthy diff')
  if (changes.some(c => !['A', 'M'].includes(c.status) || c.mode !== '100644' || (c.oldMode !== '000000' && c.oldMode !== '100644'))) reasons.push('deletion, rename or non-regular/mode-changing file')
  if (files.some(globalPath)) reasons.push('global configuration, schema, policy or security input')
  if (areas.includes('unknown')) reasons.push('unmapped file')
  if (files.some(f => !plan.graph.nodes[`source:${f}`])) reasons.push('file absent from graph')
  if (plan.unresolved.some(u => files.includes(u.file))) reasons.push('changed source has unresolved/generated imports')
  let full = reasons.length > 0
  const docs = !full && isDocsOnly(files)
  let affected = []
  try {
    affected = Object.keys((await filterAffected(plan.graph, files.map(file => ({ file, getChanges: () => [] })), {}, {})).nodes)
  } catch (error) { full = true; reasons.push(`Nx affected failed (${error.name})`) }
  const selected = new Set(affected)
  // Source policies and security/credential/release regressions stay unconditional.
  const always = /test:(?:ui-policy|i18n|release-security|credentials|test-accounts|execution-rules|abuse|signup-turnstile|db-runner)|(?:i18n:check|check:agent-ui|check:agent-definitions)/
  const units = Object.entries(tasks).filter(([key, value]) => !docs && (full || selected.has(taskId(key)) || always.test(value.command) || key === 'core-triage')).map(([key]) => taskId(key))
  let suites = docs ? [] : plan.db.scripts.filter(s => full || selected.has(dbId(s)))
  // Server paths without a proven suite mapping must never silently skip DB.
  if (!docs && areas.includes('api/factory/coordinator') && suites.length === 0) {
    suites = plan.db.scripts; reasons.push('server change without proven DB coverage: all DB suites')
  }
  // A migration changes the schema every suite runs against, so it keeps the
  // full DB inventory. It is deliberately not a GLOBAL input: GLOBAL also turns
  // on the macOS packaged acceptance, and a new table says nothing about UI
  // rendering. `test:migrations` stays in the unit set through `always`.
  if (!docs && areas.includes('database/migrations')) {
    suites = plan.db.scripts; reasons.push('migration: all DB suites')
  }
  const shardCount = Math.min(4, Math.ceil(suites.length / 8))
  const flags = {
    source: !docs, daemon: !docs && (full || selected.has('@mikka/daemon') || areas.includes('daemon')),
    mobile: !docs && (full || selected.has('@mikka/mobile') || areas.includes('mobile')),
    desktop: !docs && (full || selected.has('@mikka/desktop') || areas.includes('desktop')),
    image: !docs && (full || areas.includes('self-hosted/image') || files.some(isSelfHostedBackendInput) || files.some(f => area(f) === 'api/factory/coordinator' && !/\.(?:test|spec)\.[^.]+$/.test(f))),
    analytics: !docs && (full || files.some(f => /analytics|posthog|instrumentation|^apps\/frontend\/|^app\/\[locale\]\/layout/.test(f))),
  }
  return { version: 1, full, docs_only: docs, areas, reasons, affected, units,
    unit_tasks: units.map(id => ({ project: id, target: `ci-tasks:${id.slice(3)}`, command: tasks[id.slice(3)].command.trim(), reason: full ? 'full validation' : always.test(tasks[id.slice(3)].command) || id === 'ci-core-triage' ? 'mandatory source/security policy' : 'Nx reverse dependency' })),
    db_suites: suites,
    db_matrix: { shard: Array.from({ length: shardCount }, (_, i) => `${i + 1}/${shardCount}`) }, ...flags }
}
export function emit(result, env = process.env) {
  if (env.GITHUB_OUTPUT) {
    const values = { ...result, db: result.db_suites.length > 0, core: result.units.some(n => n.startsWith('ci-core-')), integration: result.units.some(n => n.startsWith('ci-integration-')) }
    for (const [key, value] of Object.entries(values)) appendFileSync(env.GITHUB_OUTPUT, `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}\n`)
  }
  const summary = `## Dependency-aware CI selection\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n\nInventory validated independently; skipped tasks are outside this affected closure. Full regressions remain available by dispatch/schedule.\n`
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary)
  console.log(JSON.stringify(result, null, 2))
}
export async function main(env = process.env) {
  const root = env.CI_CANDIDATE_ROOT || process.cwd()
  const plan = buildGraph(root) // Always validates the entire candidate DB inventory.
  const event = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH)) : {}
  const range = env.CI_BASE && env.CI_HEAD ? [env.CI_BASE, env.CI_HEAD] : diffRange(env, event)
  let changes = [], force = env.CI_FORCE_FULL === 'true'
  try {
    if (range.length !== 2 || range.some(s => !s || /^0+$/.test(s))) throw Error('noRange')
    if (env.GITHUB_EVENT_NAME === 'push') execFileSync('git', ['merge-base', '--is-ancestor', ...range], { cwd: root })
    const raw = execFileSync('git', ['diff', '--no-renames', '--raw', '--no-abbrev', '-z', `${range[0]}...${range[1]}`], { cwd: root, encoding: 'utf8' }).split('\0')
    for (let i = 0; i < raw.length - 1; i += 2) {
      const [oldMode, mode, , , status] = raw[i].slice(1).split(' ')
      changes.push({ file: raw[i + 1], status, mode, oldMode })
    }
  } catch { force = true }
  const result = await select(plan, changes, { force })
  if (env.CI_SELECTION_FILE) writeFileSync(env.CI_SELECTION_FILE, JSON.stringify(result, null, 2) + '\n')
  emit(result, env)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
