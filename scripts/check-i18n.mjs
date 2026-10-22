import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const ROOT = process.cwd()
const LOCALES = ['zh-CN', 'en']
const MESSAGES_DIR = path.join(ROOT, 'messages')
const CJK = /[㐀-䶿一-鿿豈-﫿]/
const SOURCE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx']

export function flattenMessages(value, prefix = '', out = new Map()) {
  for (const [key, child] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${key}` : key
    if (child && typeof child === 'object' && !Array.isArray(child)) flattenMessages(child, next, out)
    else out.set(next, child)
  }
  return out
}

export function extractPlaceholders(value) {
  return new Set([...String(value).matchAll(/\{\s*([A-Za-z0-9_]+)\s*[,}]/g)].map(match => match[1]))
}

export function compareMessages(messages) {
  const [first, ...rest] = LOCALES
  const reference = flattenMessages(messages[first])
  const problems = []
  for (const locale of rest) {
    const current = flattenMessages(messages[locale])
    for (const key of reference.keys()) {
      if (!current.has(key)) problems.push(`${locale}: missing key "${key}"`)
    }
    for (const key of current.keys()) {
      if (!reference.has(key)) problems.push(`${locale}: extra key "${key}"`)
    }
  }
  for (const locale of LOCALES) {
    const flat = flattenMessages(messages[locale])
    for (const [key, value] of flat) {
      if (typeof value !== 'string' || !value.trim()) problems.push(`${locale}: "${key}" must be a non-empty string`)
      else if (value.includes('\uFFFD')) problems.push(`${locale}: "${key}" contains a Unicode replacement character`)
    }
  }
  const english = flattenMessages(messages.en)
  const chinese = flattenMessages(messages['zh-CN'])
  for (const key of english.keys()) {
    if (!chinese.has(key)) continue
    const a = extractPlaceholders(english.get(key))
    const b = extractPlaceholders(chinese.get(key))
    for (const name of a) if (!b.has(name)) problems.push(`zh-CN: "${key}" is missing placeholder {${name}}`)
    for (const name of b) if (!a.has(name)) problems.push(`en: "${key}" is missing placeholder {${name}}`)
  }
  return problems
}

export function extractActionErrorCodes(source) {
  const match = source.match(/ACTION_ERROR_CODES\s*=\s*\[([\s\S]*?)\]\s*as const/)
  if (!match) return null
  return [...match[1].matchAll(/['"]([A-Za-z0-9_]+)['"]/g)].map(item => item[1])
}

export function checkErrorCodes(codes, messages) {
  const problems = []
  for (const locale of LOCALES) {
    const errors = messages[locale]?.Errors
    if (!errors) {
      problems.push(`${locale}: missing "Errors" namespace`)
      continue
    }
    for (const code of codes) {
      if (typeof errors[code] !== 'string' || !errors[code].trim()) problems.push(`${locale}: Errors.${code} is missing`)
    }
  }
  return problems
}

function resolveImport(specifier, fromFile) {
  let base
  if (specifier.startsWith('@/')) base = path.join(ROOT, specifier.slice(2))
  else if (specifier.startsWith('.')) base = path.resolve(path.dirname(fromFile), specifier)
  else return null
  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = `${base}${extension}`
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  return null
}

function collectEntryPoints() {
  const entries = []
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/^(page|layout|not-found|global-not-found|route|error|template)\.(ts|tsx)$/.test(entry.name)) entries.push(full)
    }
  }
  walk(path.join(ROOT, 'app'))
  return entries
}

export function collectReachableFiles(entries = collectEntryPoints()) {
  const seen = new Set()
  const stack = [...entries]
  while (stack.length) {
    const file = stack.pop()
    if (!file || seen.has(file)) continue
    seen.add(file)
    if (!/\.(ts|tsx|js|jsx)$/.test(file)) continue
    const source = fs.readFileSync(file, 'utf8')
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const visit = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const resolved = resolveImport(node.moduleSpecifier.text, file)
        if (resolved) stack.push(resolved)
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return [...seen].filter(file => file.startsWith(path.join(ROOT, 'app')) || file.startsWith(path.join(ROOT, 'components')) || file.startsWith(path.join(ROOT, 'lib')))
}

function hasIgnoreComment(source, line) {
  const lines = source.split('\n')
  const current = lines[line - 1] ?? ''
  if (current.includes('i18n-ignore')) return true
  return lines.slice(Math.max(0, line - 2), line - 1).some(value => value.includes('i18n-ignore'))
}

function isConsoleCall(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isCallExpression(current)) {
      const expression = current.expression
      if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === 'console') return true
    }
  }
  return false
}

function isModuleSpecifier(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current)) return true
  }
  return false
}

export function findHardcodedText(file, source) {
  if (source.slice(0, 400).includes('i18n-ignore-file')) return []
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const problems = []
  const seen = new Set()
  const report = (node, text) => {
    if (!CJK.test(text)) return
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    if (hasIgnoreComment(source, line + 1)) return
    const key = `${line}:${character}:${text}`
    if (seen.has(key)) return
    seen.add(key)
    problems.push(`${path.relative(ROOT, file)}:${line + 1}:${character + 1} hardcoded text "${text.trim().slice(0, 60)}"`)
  }
  const visit = node => {
    if (ts.isJsxText(node)) report(node, node.text)
    else if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      report(node, node.initializer.text)
      return
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!isModuleSpecifier(node) && !isConsoleCall(node)) report(node, node.text)
    } else if (ts.isTemplateExpression(node)) {
      report(node, node.getText(sourceFile))
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return problems
}

function unwrapAwait(node) {
  return ts.isAwaitExpression(node) ? node.expression : node
}

function namespaceOfCall(node) {
  if (!ts.isCallExpression(node)) return null
  const callee = node.expression
  if (!ts.isIdentifier(callee) || (callee.text !== 'useTranslations' && callee.text !== 'getTranslations')) return null
  const [argument] = node.arguments
  if (!argument) return ''
  if (ts.isStringLiteral(argument)) return argument.text
  if (ts.isObjectLiteralExpression(argument)) {
    for (const property of argument.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue
      if (property.name.text !== 'namespace') continue
      const value = unwrapAwait(property.initializer)
      if (ts.isStringLiteral(value)) return value.text
    }
  }
  return null
}

/**
 * Finds literal `t('key')` calls whose resolved key is absent from the reference
 * catalog. A missing key renders as the raw key in the UI, which the CJK scan
 * cannot see in English locales.
 */
export function findMissingTranslationKeys(file, source, reference) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const namespaces = new Map()
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const namespace = namespaceOfCall(unwrapAwait(node.initializer))
      if (namespace !== null) {
        if (!namespaces.has(node.name.text)) namespaces.set(node.name.text, new Set())
        namespaces.get(node.name.text).add(namespace)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  const problems = []
  const reported = new Set()
  const check = node => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text) &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const found = namespaces.get(node.expression.text)
      // The same variable name bound to two namespaces is ambiguous; skip it.
      if (found.size === 1) {
        const [namespace] = found
        const key = namespace ? `${namespace}.${node.arguments[0].text}` : node.arguments[0].text
        if (!reference.has(key) && !reported.has(key)) {
          reported.add(key)
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          problems.push(`${path.relative(ROOT, file)}:${line + 1} missing translation key "${key}"`)
        }
      }
    }
    ts.forEachChild(node, check)
  }
  check(sourceFile)
  return problems
}

export function checkRepository() {
  const messages = {}
  const problems = []
  for (const locale of LOCALES) {
    const file = path.join(MESSAGES_DIR, `${locale}.json`)
    if (!fs.existsSync(file)) {
      problems.push(`messages/${locale}.json is missing`)
      continue
    }
    try {
      messages[locale] = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      problems.push(`messages/${locale}.json is invalid JSON: ${error.message}`)
    }
  }
  if (problems.length) return problems
  problems.push(...compareMessages(messages))
  const codeFile = path.join(ROOT, 'lib/action-result.ts')
  if (fs.existsSync(codeFile)) {
    const codes = extractActionErrorCodes(fs.readFileSync(codeFile, 'utf8'))
    if (!codes) problems.push('lib/action-result.ts does not define ACTION_ERROR_CODES')
    else problems.push(...checkErrorCodes(codes, messages))
  }
  const reference = flattenMessages(messages[LOCALES[0]])
  for (const file of collectReachableFiles()) {
    if (!/\.(tsx?|jsx?)$/.test(file)) continue
    const source = fs.readFileSync(file, 'utf8')
    problems.push(...findHardcodedText(file, source))
    problems.push(...findMissingTranslationKeys(file, source, reference))
  }
  return problems
}

function main() {
  const problems = checkRepository()
  if (problems.length) {
    console.error(`i18n check failed with ${problems.length} problem(s):`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exitCode = 1
    return
  }
  console.log('i18n check passed: messages aligned, placeholders match, no hardcoded CJK in reachable UI.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
