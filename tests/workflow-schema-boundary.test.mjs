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

test('Coordinator schemas cannot bring Node/server modules across the durable Workflow boundary', () => {
  const workflow = resolve(root, 'workflows/coordinator/workflow.ts')
  const names = new Set(['factoryDispatchSchema', 'contextQuestionAnswerSchema', 'questionReferenceSchema', 'questionEscalationSchema', 'commandSchema', 'skillEvaluationCommandSchema'])
  const roots = source(workflow).statements.flatMap(statement => {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) return []
    return statement.importClause.namedBindings.elements.some(item => names.has(item.name.text)) ? [localPath(statement.moduleSpecifier.text, workflow)] : []
  })
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
