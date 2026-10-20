import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { auditSource, auditCss, sourceHash } from './ui-policy.mjs'

const policy = JSON.parse(readFileSync('ui-policy.json', 'utf8'))
const lock = JSON.parse(readFileSync(policy.registryLock, 'utf8'))
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(file => /\.(?:[cm]?[jt]sx?|css)$/.test(file) && !/^(?:scripts|node_modules|\.next|out|build|user_read_only_context|v0_memories)\//.test(file) && !file.endsWith('.d.ts') && existsSync(file))
const diagnostics = []
const config = JSON.parse(readFileSync('components.json', 'utf8'))
if (config.style !== policy.style || config.iconLibrary !== policy.iconLibrary.replace('-react', '')) diagnostics.push({ file: 'components.json', line: 1, column: 1, rule: 'policy/config-drift', message: '组件 base/style/iconLibrary 与 ui-policy.json 不一致；变更预设需同步审核策略。' })
const receipts = new Map(Object.entries(lock.items).flatMap(([item, value]) => value.files.map(file => [file.path, { ...file, item }])))
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const receipt = receipts.get(file)
  const verified = receipt && sourceHash(text, file) === receipt.sha256
  if (receipt && !verified) diagnostics.push({ file, line: 1, column: 1, rule: 'registry/source-modified', message: `${receipt.item} 与已审核的 registry/CLI 输出不同；需核实下载版本或源码改写，不能按目录豁免。` })
  const isUiSource = /^components\/(?:ui|reui)\//.test(file)
  if (isUiSource && !receipt) diagnostics.push({ file, line: 1, column: 1, rule: 'registry/missing-receipt', message: '基础组件缺少 registry 下载凭据；不能仅按目录豁免。' })
  diagnostics.push(...(file.endsWith('.css') ? auditCss(file, text, policy) : auditSource(file, text, policy, { verified: Boolean(verified) })))
}
const counts = Object.fromEntries([...new Set(diagnostics.map(d => d.rule))].sort().map(rule => [rule, diagnostics.filter(d => d.rule === rule).length]))
if (process.argv.includes('--json')) console.log(JSON.stringify({ files: files.length, errors: diagnostics.length, counts, diagnostics }, null, 2))
else {
  for (const diagnostic of diagnostics) console.error(`${diagnostic.file}:${diagnostic.line}:${diagnostic.column} error [${diagnostic.rule}] ${diagnostic.message}`)
  console.log(`\nUI policy: ${files.length} files, ${diagnostics.length} errors (no baseline/allowlist).`)
  console.log(JSON.stringify(counts, null, 2))
}
process.exitCode = diagnostics.length ? 1 : 0
