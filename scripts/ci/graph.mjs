// Explicit file nodes keep root lib domains independent without moving product code.
// Nx follows reverse import/contract edges from a changed file to its consumers.
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, globSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import ts from 'typescript'
import { inventory, readTree, REQUIRED_SUITES } from '../run-db-tests.mjs'
import tasks from './tasks.json' with { type: 'json' }

export const sourceId = file => `source:${file}`
export const taskId = key => `ci-${key}`
export const dbId = script => `db-${script.replaceAll(':', '-')}`
const code = /\.(?:[cm]?[jt]sx?)$/
const testFile = /(?:\.test\.|\.spec\.|\/test[s]?\/)/
export function buildGraph(root = process.cwd()) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
  const present = new Set(files.filter(file => existsSync(resolve(root, file))))
  const nodes = {}, dependencies = {}, unresolved = []
  const add = (name, data) => { nodes[name] = { name, type: 'lib', data: { name, ...data } }; dependencies[name] = [] }
  const edge = (source, target) => {
    if (source !== target && nodes[source] && nodes[target] && !dependencies[source].some(e => e.target === target)) dependencies[source].push({ source, target, type: 'implicit' })
  }
  for (const file of [...present].filter(f => f !== 'scripts/ci/project.json')) add(sourceId(file), { root: file, tags: ['source'], targets: {} })
  const packages = files.filter(f => /^(apps|packages)\/[^/]+\/package.json$/.test(f)).map(file => ({
    ...JSON.parse(readFileSync(resolve(root, file))), root: posix.dirname(file),
  }))
  function resolveImport(file, spec) {
    let base
    if (spec.startsWith('.')) base = posix.normalize(posix.join(posix.dirname(file), spec))
    else if (spec.startsWith('@/')) base = (file.startsWith('apps/mobile/') ? 'apps/mobile/' : '') + spec.slice(2)
    else if (spec.startsWith('@ui-slot/')) base = `components/slots/${spec.slice(9)}`
    else {
      const pkg = packages.find(p => spec === p.name || spec.startsWith(`${p.name}/`))
      if (!pkg) return [] // External modules are covered by global lockfile inputs.
      return files.filter(f => f.startsWith(`${pkg.root}/`) && !testFile.test(f))
    }
    const bases = [base, base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx')]
    for (const path of bases.flatMap(b => [b, ...['.ts', '.tsx', '.mjs', '.js', '.json', '/index.ts', '/index.tsx', '/index.js'].map(ext => b + ext)])) if (present.has(path)) return [path]
    // Missing optional/platform/generated imports are recorded, never evaluated.
    unresolved.push({ file, spec })
    return []
  }
  for (const file of files.filter(f => code.test(f) && present.has(f))) {
    const source = readFileSync(resolve(root, file), 'utf8')
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    if (ast.parseDiagnostics.length) unresolved.push({ file, spec: '<parse error>' })
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        for (const target of resolveImport(file, node.moduleSpecifier.text)) edge(sourceId(file), sourceId(target))
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(ast) === 'require')) {
        if (node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) for (const target of resolveImport(file, node.arguments[0].text)) edge(sourceId(file), sourceId(target))
        else unresolved.push({ file, spec: '<computed import>' })
      }
      // Source-contract and filesystem tests often name their input instead of importing it.
      if (ts.isStringLiteralLike(node)) {
        const value = node.text.replace(/^\.\//, '')
        if (present.has(value)) edge(sourceId(file), sourceId(value))
        const relative = posix.normalize(posix.join(posix.dirname(file), value))
        if (present.has(relative)) edge(sourceId(file), sourceId(relative))
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
  const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'))).scripts
  const db = inventory(readTree(root), scripts)
  function commandFiles(command, seen = new Set()) {
    const result = new Set()
    for (const match of command.matchAll(/pnpm\s+(?:-s\s+|--silent\s+)?([\w:-]+)/g)) {
      const key = match[1]
      if (scripts[key] && !seen.has(key)) { seen.add(key); for (const f of commandFiles(scripts[key], seen)) result.add(f) }
    }
    for (const token of command.split(/\s+/).map(t => t.replace(/^['"]|['"]$/g, ''))) {
      if (present.has(token)) result.add(token)
      else if (/[?*]/.test(token) && !token.startsWith('-')) for (const f of globSync(token, { cwd: root })) if (present.has(f)) result.add(f)
    }
    // A workspace command can test generated files or use its own cwd/globs.
    for (const pkg of packages) if (command.includes(`--filter ${pkg.name} `)) for (const f of files) if (f.startsWith(`${pkg.root}/`)) result.add(f)
    return [...result]
  }
  const addTask = (name, command, kind, extra = []) => {
    add(name, { root: `ci-projects/${name}`, tags: [kind], targets: {} })
    for (const file of [...commandFiles(command), ...extra]) edge(name, sourceId(file))
  }
  for (const [key, value] of Object.entries(tasks)) addTask(taskId(key), value.command, value.kind, [])
  for (const script of db.scripts) addTask(dbId(script), scripts[script], 'database', REQUIRED_SUITES.filter(s => s.script === script).map(s => s.marker))
  // Package project nodes also describe runtime consumers, not only tests.
  for (const pkg of packages) {
    add(pkg.name, { root: pkg.root, tags: ['package'], targets: Object.fromEntries(['test', 'typecheck', 'build'].filter(k => pkg.scripts?.[k]).map(k => [k, { command: `pnpm --filter ${pkg.name} ${k}`, cache: false }])) })
    for (const file of files) if (file.startsWith(`${pkg.root}/`)) edge(pkg.name, sourceId(file))
  }
  add('ci-tasks', { root: 'scripts/ci', tags: ['scheduler'], targets: Object.fromEntries(Object.entries(tasks).map(([key, task]) => [key, { executor: 'nx:run-commands', cache: false, inputs: [], outputs: [], options: { command: task.command, cwd: '.', env: task.env } }])) })
  return { graph: { nodes, dependencies, externalNodes: {} }, db, unresolved, files }
}
