// Design-token guard: icons use the global 1.5 stroke (svg.lucide in app/globals.css), and
// colors come from theme tokens. Forbids `strokeWidth` on lucide-react icons and raw hex
// colors anywhere under components/. Brand logos / canvas art are allowlisted explicitly.
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const HEX_ALLOWLIST = new Set([
  'components/ui/svgs/githubLight.tsx', // third-party brand logo
  'components/ui/svgs/githubDark.tsx', // third-party brand logo
  'components/ui/svgs/google.tsx', // third-party brand logo
  'components/ui/chart.tsx', // shadcn chart: matches recharts' internal default fills to restyle them
  'components/reui/code-block/code-block-highlight.tsx', // syntax-highlighting theme palette
  'components/agents/voice-orb.tsx', // canvas gradient defaults (not CSS)
  'components/blocks/rich-text-editor-4/components/value-faces.tsx', // illustrative avatar art
])

const HEX = /(?<![\w&/-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b(?![\w-])/g

export function auditTokens(file, text) {
  const diagnostics = []
  const at = index => { const before = text.slice(0, index).split('\n'); return { line: before.length, column: before.at(-1).length + 1 } }
  const lucide = new Set()
  for (const match of text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]lucide-react['"]/g)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).at(-1)?.trim()
      if (name && /^[A-Z]/.test(name)) lucide.add(name)
    }
  }
  for (const match of text.matchAll(/<([A-Z][\w.]*)\b[^<>]*?\bstrokeWidth\s*=/g)) {
    if (lucide.has(match[1]) || match[1].endsWith('.icon')) diagnostics.push({ file, ...at(match.index), rule: 'tokens/no-icon-stroke', message: `${match[1]} 不要单独设置 strokeWidth；图标线宽统一由 svg.lucide (1.5) 控制。` })
  }
  if (!HEX_ALLOWLIST.has(file)) {
    for (const match of text.matchAll(HEX)) {
      const lineStart = text.lastIndexOf('\n', match.index) + 1
      const line = text.slice(lineStart, text.indexOf('\n', match.index) >>> 0)
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line) || /https?:\/\/\S*$/.test(text.slice(lineStart, match.index))) continue
      diagnostics.push({ file, ...at(match.index), rule: 'tokens/no-raw-hex', message: `不要写死颜色 ${match[0]}；请使用 app/globals.css 中的主题 token。` })
    }
  }
  return diagnostics
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', 'components'], { encoding: 'utf8' })
    .split('\0').filter(file => /\.[cm]?[jt]sx?$/.test(file) && existsSync(file))
  const diagnostics = files.flatMap(file => auditTokens(file, readFileSync(file, 'utf8')))
  for (const d of diagnostics) console.error(`${d.file}:${d.line}:${d.column} error [${d.rule}] ${d.message}`)
  console.log(`Token policy: ${files.length} files under components/, ${diagnostics.length} errors.`)
  process.exitCode = diagnostics.length ? 1 : 0
}
