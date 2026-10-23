import assert from 'node:assert/strict'
import test from 'node:test'
import { auditTokens } from './lint-tokens.mjs'

test('禁止在 lucide 图标上设置 strokeWidth，原生 svg 不受影响', () => {
  const bad = `import { Check as Tick } from 'lucide-react'\nexport const A = () => <Tick className="size-4" strokeWidth={2} />`
  assert.equal(auditTokens('components/x.tsx', bad)[0].rule, 'tokens/no-icon-stroke')
  assert.deepEqual(auditTokens('components/x.tsx', `export const B = () => <svg><path strokeWidth="2" /></svg>`), [])
})

test('禁止 components/ 中写死十六进制颜色，允许注释和链接锚点', () => {
  assert.equal(auditTokens('components/x.tsx', `const c = "#1a1b1e"`)[0].rule, 'tokens/no-raw-hex')
  assert.deepEqual(auditTokens('components/x.tsx', `// see #123 for context\nconst u = 'https://a.dev/page#abc'\nconst s = '&#123;'`), [])
  assert.deepEqual(auditTokens('components/agents/voice-orb.tsx', `const c = "#e8754d"`), [])
})
