import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])
const rootDirectory = fileURLToPath(new URL('../../..', import.meta.url))
const exported = node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
const names = node => ts.isIdentifier(node) ? [node.text] : node.elements.flatMap(element => ts.isBindingElement(element) ? names(element.name) : [])
const hash = value => createHash('sha256').update(value).digest('hex')

/** Inspect declarations only. Generating a route map must never initialize a
 * store, authentication provider, Workflow, or a handler's module side effects. */
export async function inspectRoute(root, file, visiting = new Set()) {
  const absolute = resolve(root, file)
  if (!absolute.startsWith(`${resolve(root)}${sep}`) || visiting.has(absolute)) throw new Error('API_ROUTE_SOURCE_INVALID')
  const source = await readFile(absolute, 'utf8')
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const exports = new Map(), declarations = new Map()
  const seen = new Set(visiting).add(absolute)
  for (const statement of parsed.statements) {
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      for (const name of names(declaration.name)) {
        declarations.set(name, declaration.initializer)
        if (exported(statement)) exports.set(name, declaration.initializer)
      }
    }
    if (ts.isFunctionDeclaration(statement) && statement.name && exported(statement)) exports.set(statement.name.text, undefined)
  }
  for (const statement of parsed.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue
    const specifier = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined
    let referenced
    if (specifier) {
      if (!specifier.startsWith('.') && !specifier.startsWith('@/')) throw new Error('API_ROUTE_REEXPORT_UNRESOLVED')
      const path = specifier.startsWith('@/') ? resolve(root, specifier.slice(2)) : resolve(dirname(absolute), specifier)
      referenced = await inspectRoute(root, `${relative(root, path).replace(/\\/g, '/')}${/\.[cm]?[jt]sx?$/.test(path) ? '' : '.ts'}`, seen)
    }
    if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly) continue
        const original = element.propertyName?.text ?? element.name.text
        exports.set(element.name.text, referenced ? referenced.values.get(original) : declarations.get(original))
      }
    } else if (!statement.exportClause && referenced) for (const entry of referenced.values) exports.set(...entry)
  }
  let maxDuration
  if (exports.has('maxDuration')) {
    const value = exports.get('maxDuration')
    const numeric = typeof value === 'number' ? value : value && ts.isNumericLiteral(value) ? Number(value.text) : NaN
    if (!Number.isInteger(numeric) || numeric < 1 || numeric > 800) throw new Error('API_ROUTE_DURATION_INVALID')
    maxDuration = numeric
    exports.set('maxDuration', numeric)
  }
  return { methods: [...exports.keys()].filter(name => methods.has(name)).sort(), maxDuration, sourceHash: hash(source), values: exports }
}

async function routeFiles(root) {
  const found = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name === 'route.ts') found.push(relative(root, path).replace(/\\/g, '/'))
    }
  }
  await visit(join(root, 'app'))
  return found.sort()
}

const specificity = path => path.split('/').map(segment => segment.startsWith('[[...') ? '3' : segment.startsWith('[...') ? '2' : segment.startsWith('[') ? '1' : `0${segment}`).join('/')
export async function generateRoutes(root = rootDirectory) {
  const inputs = (await routeFiles(root)).map(source => ({ source, template: '/' + source.slice(4, -'/route.ts'.length).split('/').filter(segment => !/^\(.*\)$/.test(segment)).join('/') }))
  inputs.push({ source: 'apps/api/routes/browser-rpc.ts', template: '/api/rpc' }, { source: 'apps/api/routes/oauth-consent.ts', template: '/api/frontend/oauth-consent' })
  const routes = []
  for (const input of inputs) {
    const { methods, maxDuration, sourceHash } = await inspectRoute(root, input.source)
    if (!methods.length || !/^\/(?:api|v1|\.well-known|w)(?:\/|$)/.test(input.template)) throw new Error('API_ROUTE_DECLARATION_INVALID')
    routes.push({ path: `/mikka${input.template}`, template: input.template, source: input.source, methods, ...(maxDuration ? { maxDuration } : {}), sourceHash })
  }
  routes.sort((left, right) => specificity(left.path).localeCompare(specificity(right.path)))
  if (new Set(routes.map(route => route.path)).size !== routes.length) throw new Error('API_ROUTE_DUPLICATE')
  const directory = join(root, 'apps/api/generated')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'routes.json'), `${JSON.stringify({ version: 1, basePath: '/mikka', routes }, null, 2)}\n`)
  await writeFile(join(directory, 'routes.ts'), `// Generated by apps/api/scripts/generate-routes.mjs; declarations only.\nimport type { ApiRoute } from '../src/routes'\nexport const routes: ApiRoute[] = [\n${routes.map(route => `  { ...${JSON.stringify(route)}, load: () => import(${JSON.stringify('../../../' + route.source.replace(/\.ts$/, ''))}) },`).join('\n')}\n]\n`)
  return routes
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const routes = await generateRoutes()
  console.log(JSON.stringify({ routes: routes.length, methods: routes.reduce((count, route) => count + route.methods.length, 0) }))
}
