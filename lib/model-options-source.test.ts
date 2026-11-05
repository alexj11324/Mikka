import assert from 'node:assert/strict'
import test from 'node:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

// Alex, 2026-11-02: a model list shows only what a CLI or daemon reported (or, on Mikka Cloud,
// the connected account's catalogue). No model name is written into lib/ or components/ as an
// option, a default or a stand-in. This walks every string literal there; comments do not count.
const ROOT = join(import.meta.dirname, '..')
const DIRS = ['lib', 'components']
const MODEL_NAME = /^(?:opus|sonnet|haiku|claude-(?:opus|sonnet|haiku)[\w.-]*|gpt-[\w.-]+|o[1-9](?:-mini|-pro)?|codex-mini[\w.-]*)$/i
/** Literals that name something else, each with why. Keyed by file and text, so a new use elsewhere still fails. */
const NOT_MODEL_OPTIONS = new Map<string, string>([
  // Claude's usage answer names its per-model weekly meters "Opus" and "Sonnet"; matching them reads quota, it offers no model.
  ['lib/subscription-usage.ts "Opus"', 'quota meter name'],
  ['lib/subscription-usage.ts "Sonnet"', 'quota meter name'],
  // Alex, 2026-11-02 (decision 2026-11-02-1400): how an untouched 优先使用的模型 list is filled. A preference word
  // matched against reported ids and names; it never adds a model nothing reported (DEFAULT_ORDER_PREFERENCE).
  ['lib/model-order-plan.ts "opus"', 'default-order preference word'],
])

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path)
    return /\.(ts|tsx)$/.test(name) && !/\.(test|spec|stories)\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [path] : []
  })
}

/** Issue #1329 permits exact tier/effort metadata for reported models. Only
 * property keys in these two top-level tables are exempt; they never supply
 * selectable models, and an unknown model remains standard. Model options or
 * defaults anywhere else, even in this file, still fail the global guard. */
function routingMetadataKey(path: string, node: ts.StringLiteralLike): boolean {
  if (relative(ROOT, path) !== 'lib/model-routing.ts' || !ts.isPropertyAssignment(node.parent) || node.parent.name !== node) return false
  let ancestor: ts.Node | undefined = node.parent
  while (ancestor && !ts.isVariableDeclaration(ancestor)) ancestor = ancestor.parent
  return Boolean(ancestor && ts.isVariableDeclaration(ancestor) && ts.isIdentifier(ancestor.name)
    && ['MODEL_TIERS', 'EFFORT_MODELS'].includes(ancestor.name.text)
    && ts.isVariableStatement(ancestor.parent.parent) && ts.isSourceFile(ancestor.parent.parent.parent))
}

function modelLiterals(path: string, source = readFileSync(path, 'utf8')): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const found: string[] = []
  const visit = (node: ts.Node) => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && MODEL_NAME.test(node.text.trim())
      && !NOT_MODEL_OPTIONS.has(`${relative(ROOT, path)} ${JSON.stringify(node.text)}`) && !routingMetadataKey(path, node)) {
      found.push(`${relative(ROOT, path)}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${JSON.stringify(node.text)}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

test('no model name is written into lib/ or components/: model options come only from what was reported', () => {
  const found = DIRS.flatMap(dir => sources(join(ROOT, dir))).flatMap(path => modelLiterals(path))
  assert.deepEqual(found, [])
})

test('the guard catches a written model name and ignores comments', () => {
  const probe = ts.createSourceFile('probe.ts', "// opus in a comment\nconst slot = 'opus'\nconst id = `gpt-5`\nconst other = 'reported-a'", ts.ScriptTarget.Latest, true)
  const texts: string[] = []
  const visit = (node: ts.Node) => { if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && MODEL_NAME.test(node.text)) texts.push(node.text); ts.forEachChild(node, visit) }
  visit(probe)
  assert.deepEqual(texts, ['opus', 'gpt-5'])
})

test('routing metadata exemption cannot hide model options, defaults or another file', () => {
  const metadata = "const MODEL_TIERS = Object.freeze({ 'gpt-6-luna': 'light' }); const EFFORT_MODELS = { codex: { 'gpt-6-luna': ['low'] } }"
  const path = join(ROOT, 'lib/model-routing.ts')
  assert.deepEqual(modelLiterals(path, metadata), [])
  assert.equal(modelLiterals(join(ROOT, 'lib/another-model-list.ts'), metadata).length, 2)
  for (const source of ["const options = ['gpt-6-luna']", "const fallback = 'gpt-6-luna'", "const OTHER_MODELS = { 'gpt-6-luna': 'light' }",
    "const MODEL_TIERS = { fallback: 'gpt-6-luna' }", "function list() { const MODEL_TIERS = { 'gpt-6-luna': 'light' }; return MODEL_TIERS }"]) {
    assert.equal(modelLiterals(path, source).length, 1, source)
  }
})
