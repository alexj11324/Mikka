import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
function source(path) { return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true) }
function localPath(specifier, from) {
  const base = specifier.startsWith('@/') ? resolve(root, specifier.slice(2))
    : specifier.startsWith('@mikka/protocol/') ? resolve(root, 'packages/protocol/src', specifier.slice('@mikka/protocol/'.length))
      : specifier.startsWith('.') ? resolve(dirname(from), specifier) : null
  if (!base) return null
  const path = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(existsSync)
  assert.ok(path, `Missing schema dependency ${specifier} from ${from}`)
  return path
}
function imports(file) {
  return source(file).statements.flatMap(statement => {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) return []
    if (statement.isTypeOnly || statement.importClause?.isTypeOnly || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) return []
    const bindings = statement.importClause?.namedBindings ?? statement.exportClause
    if (!statement.importClause?.name && bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) && bindings.elements.length && bindings.elements.every(item => item.isTypeOnly)) return []
    return [statement.moduleSpecifier.text]
  })
}

test('product tool schemas keep their durable invocation boundary free of server modules', () => {
  // Product tool registries remain callable from durable business workflows.
  // Eve owns the agent loop; Node work still belongs in the tool implementations.
  const names = new Set(['factoryCheckRecoverySchema', 'factoryDispatchSchema', 'contextQuestionAnswerSchema', 'questionReferenceSchema', 'questionEscalationSchema', 'commandSchema', 'skillEvaluationCommandSchema'])
  const coordinator = resolve(root, 'workflows/coordinator')
  const bundled = new Set()
  function bundle(file) {
    if (bundled.has(file) || readFileSync(file, 'utf8').includes("'use step'")) return
    bundled.add(file)
    for (const specifier of imports(file)) {
      const dependency = localPath(specifier, file)
      if (dependency && dirname(dependency) === coordinator) bundle(dependency)
    }
  }
  bundle(resolve(coordinator, 'tools.ts'))
  const found = new Set()
  const roots = [...bundled].flatMap(file => source(file).statements.flatMap(statement => {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly || !statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) return []
    const schemas = statement.importClause.namedBindings.elements.filter(item => !item.isTypeOnly && names.has((item.propertyName ?? item.name).text))
    schemas.forEach(item => found.add((item.propertyName ?? item.name).text))
    return schemas.length ? [localPath(statement.moduleSpecifier.text, file)] : []
  }))
  assert.ok(bundled.has(resolve(coordinator, 'tools.ts')) && bundled.has(resolve(coordinator, 'factory-tools.ts')), 'Coordinator tool registries are walked')
  assert.deepEqual([...names].filter(name => !found.has(name)), [], 'Every coordinator tool schema import is covered')
  assert.ok(roots.length > 0, 'Coordinator tool schema imports are covered')
  const visited = new Set(), forbidden = []
  function walk(file) {
    if (visited.has(file)) return
    visited.add(file)
    for (const specifier of imports(file)) {
      const dependency = localPath(specifier, file)
      if (dependency) walk(dependency)
      else if (specifier !== 'zod') forbidden.push(`${file.slice(root.length + 1)} -> ${specifier}`)
    }
  }
  roots.forEach(walk)
  assert.deepEqual(forbidden, [], 'Workflow schema roots must stay pure; keep Node work in durable steps')
})
