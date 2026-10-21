import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { auditSource, auditCss, isComponentLibrarySource } from './ui-policy.mjs'
import { auditInteractions } from './interaction-policy.mjs'

const policy = JSON.parse(readFileSync('ui-policy.json', 'utf8'))
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(file => /\.(?:[cm]?[jt]sx?|css)$/.test(file) && !/^(?:packages|scripts|node_modules|\.next|\.vercel|out|build|user_read_only_context|v0_memories)\//.test(file) && !file.endsWith('.d.ts') && existsSync(file))
const diagnostics = []
const config = JSON.parse(readFileSync('components.json', 'utf8'))
if (config.style !== policy.style || config.iconLibrary !== policy.iconLibrary.replace('-react', '')) diagnostics.push({ file: 'components.json', line: 1, column: 1, rule: 'policy/config-drift', message: '组件 base/style/iconLibrary 与 ui-policy.json 不一致；变更预设需同步审核策略。' })
const businessFiles = files.filter(file => !isComponentLibrarySource(file, policy))
for (const file of businessFiles) {
  const text = readFileSync(file, 'utf8')
  diagnostics.push(...(file.endsWith('.css') ? auditCss(file, text, policy) : auditSource(file, text, policy)))
}
const interactionFiles = files.filter(file => /\.[jt]sx$/.test(file) && !['components/ui/', 'components/reui/'].some(root => file.startsWith(root)))
for (const file of interactionFiles) diagnostics.push(...auditInteractions(file, readFileSync(file, 'utf8')))
const counts = Object.fromEntries([...new Set(diagnostics.map(d => d.rule))].sort().map(rule => [rule, diagnostics.filter(d => d.rule === rule).length]))
if (process.argv.includes('--json')) console.log(JSON.stringify({ files: businessFiles.length, libraryFiles: files.length - businessFiles.length, interactionFiles: interactionFiles.length, errors: diagnostics.length, counts, diagnostics }, null, 2))
else {
  for (const diagnostic of diagnostics) console.error(`${diagnostic.file}:${diagnostic.line}:${diagnostic.column} error [${diagnostic.rule}] ${diagnostic.message}`)
  console.log(`\nUI policy: ${businessFiles.length} business files, ${diagnostics.length} errors; ${files.length - businessFiles.length} component-library files excluded (no source verification).`)
  console.log(`Interaction policy: ${interactionFiles.length} files, including downloaded business blocks; only UI/ReUI primitives excluded.`)
  console.log(JSON.stringify(counts, null, 2))
}
process.exitCode = diagnostics.length ? 1 : 0
