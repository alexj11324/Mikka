import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { auditSource, auditCss, isComponentLibrarySource, exemptAsShipped } from './ui-policy.mjs'
import { auditActionBindings, auditInteractions } from './interaction-policy.mjs'
import { auditSettingsSurface } from './settings-policy.mjs'
import { auditIconButtons } from './icon-button-policy.mjs'
import { auditBasePath } from './base-path-policy.mjs'
import { auditEntityDetail, auditTaskEntry, verifyEntityContracts } from './entity-ui-policy.mjs'
import { auditSplitPanes } from './split-pane-policy.mjs'
import { auditRepository as auditPollingRepository } from './polling-policy.mjs'
import { auditRepository as auditErrorCauseRepository } from './error-cause-policy.mjs'

const policy = JSON.parse(readFileSync('ui-policy.json', 'utf8'))
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0')
const files = tracked.filter(file => /\.(?:[cm]?[jt]sx?|css)$/.test(file) && !/^(?:apps|packages|scripts|node_modules|\.next|\.vercel|out|build|user_read_only_context|v0_memories|\.claude)\//.test(file) && !file.endsWith('.d.ts') && existsSync(file))
const diagnostics = verifyEntityContracts(file => {
  try { return readFileSync(file, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
})
const config = JSON.parse(readFileSync('components.json', 'utf8'))
if (config.style !== policy.style || config.iconLibrary !== policy.iconLibrary.replace('-react', '')) diagnostics.push({ file: 'components.json', line: 1, column: 1, rule: 'policy/config-drift', message: '组件 base/style/iconLibrary 与 ui-policy.json 不一致；变更预设需同步审核策略。' })
const businessFiles = files.filter(file => !isComponentLibrarySource(file, policy))
for (const file of businessFiles) {
  const text = readFileSync(file, 'utf8')
  diagnostics.push(...exemptAsShipped(file, file.endsWith('.css') ? auditCss(file, text, policy) : auditSource(file, text, policy), policy))
  if (!file.endsWith('.css')) diagnostics.push(...auditBasePath(file, text), ...auditEntityDetail(file, text), ...auditTaskEntry(file, text))
  if (/\.[jt]sx$/.test(file)) diagnostics.push(...auditSettingsSurface(file, text), ...auditSplitPanes(file, text))
}
for (const file of tracked.filter(file => /^apps\/(?:mobile|desktop)\/.*\.[jt]sx?$/.test(file) && existsSync(file))) {
  diagnostics.push(...auditEntityDetail(file, readFileSync(file, 'utf8')))
}
const clientFiles = tracked.filter(file => /^apps\/(?:mobile\/(?:app|components|features|shared|slots)|desktop\/src\/renderer|frontend\/src)\/.*\.[jt]sx$/.test(file) && existsSync(file))
for (const file of clientFiles) diagnostics.push(...auditActionBindings(file, readFileSync(file, 'utf8')))
const interactionFiles = files.filter(file => /\.[jt]sx$/.test(file) && !['components/ui/', 'components/reui/'].some(root => file.startsWith(root)))
for (const file of interactionFiles) {
  const text = readFileSync(file, 'utf8')
  diagnostics.push(...auditInteractions(file, text), ...auditIconButtons(file, text))
}
// Polling covers web, mobile, daemon and workflows, so it lists its own files; stale allowlist
// entries fail in scripts/polling-policy.test.mjs (docs/design/decisions/2026-11-05-0200-no-new-polling.md).
diagnostics.push(...auditPollingRepository())
// Error causes and copy for user-reachable codes cover web, daemon and workflows too; stale allowlist
// entries fail in scripts/error-cause-policy.test.mjs (docs/design/decisions/2026-11-05-0330-error-causes.md).
diagnostics.push(...auditErrorCauseRepository())
const counts = Object.fromEntries([...new Set(diagnostics.map(d => d.rule))].sort().map(rule => [rule, diagnostics.filter(d => d.rule === rule).length]))
if (process.argv.includes('--json')) console.log(JSON.stringify({ files: businessFiles.length, libraryFiles: files.length - businessFiles.length, interactionFiles: interactionFiles.length, clientInteractionFiles: clientFiles.length, errors: diagnostics.length, counts, diagnostics }, null, 2))
else {
  for (const diagnostic of diagnostics) console.error(`${diagnostic.file}:${diagnostic.line}:${diagnostic.column} error [${diagnostic.rule}] ${diagnostic.message}`)
  console.log(`\nUI policy: ${businessFiles.length} business files, ${diagnostics.length} errors; ${files.length - businessFiles.length} component-library files excluded (no source verification).`)
  console.log(`Interaction policy: ${interactionFiles.length} files, including downloaded business blocks; plus ${clientFiles.length} native and renderer files checked for action bindings.`)
  console.log(JSON.stringify(counts, null, 2))
}
process.exitCode = diagnostics.length ? 1 : 0
