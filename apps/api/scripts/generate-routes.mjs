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
/** The tracked artifacts, the record fields in emission order, and the only
 * flag. Generation and checking must share one renderer, otherwise the check
 * could disagree with the generator about formatting alone. */
const manifestDirectory = 'apps/api/generated'
const manifestFields = ['path', 'template', 'source', 'methods', 'maxDuration', 'sourceHash']
const usage = 'Usage: node apps/api/scripts/generate-routes.mjs [--check]'

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
/** Collect the manifest in memory; never writes, so `--check` can run against
 * a clean worktree without creating or touching the tracked artifacts. */
export async function collectRoutes(root = rootDirectory) {
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
  return routes
}

/** Render both tracked artifacts. Generation and checking go through this
 * single renderer, so the check can only fail on real manifest drift. */
export function renderRouteManifest(routes) {
  return [
    ['routes.json', `${JSON.stringify({ version: 1, basePath: '/mikka', routes }, null, 2)}\n`],
    ['routes.ts', `// Generated by apps/api/scripts/generate-routes.mjs; declarations only.\nimport type { ApiRoute } from '../src/routes'\nexport const routes: ApiRoute[] = [\n${routes.map(route => `  { ...${JSON.stringify(route)}, load: () => import(${JSON.stringify('../../../' + route.source.replace(/\.ts$/, ''))}) },`).join('\n')}\n]\n`],
  ]
}

export async function generateRoutes(root = rootDirectory) {
  const routes = await collectRoutes(root)
  const directory = join(root, manifestDirectory)
  await mkdir(directory, { recursive: true })
  for (const [name, content] of renderRouteManifest(routes)) await writeFile(join(directory, name), content)
  return routes
}

const describeValue = value => JSON.stringify(value) ?? 'undefined'
const clip = text => text.length > 160 ? `${text.slice(0, 160)}...` : text

/** Byte-for-byte difference, reported as the first line that diverged. The
 * check compares raw bytes, so a reformatted manifest must fail too. */
function firstByteDifference(expected, actual) {
  const limit = Math.min(expected.length, actual.length)
  let offset = 0
  while (offset < limit && expected[offset] === actual[offset]) offset += 1
  const line = expected.slice(0, offset).split('\n').length
  const expectedLine = expected.split('\n')[line - 1] ?? '<end of file>'
  const actualLine = actual.split('\n')[line - 1] ?? '<end of file>'
  return `line ${line}: expected ${clip(expectedLine)}, found ${clip(actualLine)}`
}

function fieldDifference(expected, actual, field) {
  const before = expected[field], after = actual[field]
  if (JSON.stringify(before) === JSON.stringify(after)) return undefined
  if (field === 'methods') {
    const added = (before ?? []).filter(method => !(after ?? []).includes(method)), dropped = (after ?? []).filter(method => !(before ?? []).includes(method))
    return `field methods: expected ${describeValue(before)}, found ${describeValue(after)}${added.length ? `, source adds ${added.join('/')}` : ''}${dropped.length ? `, manifest adds ${dropped.join('/')}` : ''}`
  }
  return `field ${field}: expected ${describeValue(before)}, found ${describeValue(after)}`
}

/** Name the first route-level difference: an added route, a stale route, an
 * order change, or a single changed field on a known route. */
function firstRouteDifference(expectedRoutes, actualRoutes) {
  const expectedByPath = new Map(expectedRoutes.map(route => [route.path, route]))
  const actualByPath = new Map(actualRoutes.map(route => [route.path, route]))
  for (const route of expectedRoutes) if (!actualByPath.has(route.path)) return `route ${route.path} is declared by ${route.source} but missing from the manifest`
  for (const route of actualRoutes) if (!expectedByPath.has(route.path)) return `route ${route.path} is in the manifest but no route.ts declares it`
  for (const [index, route] of expectedRoutes.entries()) if (actualRoutes[index].path !== route.path) return `route order differs at index ${index}: expected ${route.path}, found ${actualRoutes[index].path}`
  for (const [index, expected] of expectedRoutes.entries()) {
    const actual = actualRoutes[index]
    const unknown = [...new Set([...Object.keys(expected), ...Object.keys(actual)].filter(field => !manifestFields.includes(field)))]
    for (const field of [...manifestFields, ...unknown]) {
      const difference = fieldDifference(expected, actual, field)
      if (difference) return `route ${expected.path} ${difference}`
    }
  }
  return undefined
}

function firstJsonDifference(expected, actual) {
  let manifest
  try { manifest = JSON.parse(actual) } catch { return `is not valid JSON (${firstByteDifference(expected, actual)})` }
  const source = JSON.parse(expected)
  if (manifest.version !== source.version) return `field version: expected ${describeValue(source.version)}, found ${describeValue(manifest.version)}`
  if (manifest.basePath !== source.basePath) return `field basePath: expected ${describeValue(source.basePath)}, found ${describeValue(manifest.basePath)}`
  if (!Array.isArray(manifest.routes)) return `field routes: expected ${source.routes.length} route records, found ${describeValue(manifest.routes)}`
  // A structural difference is the actionable one; a formatting-only change
  // falls through to the byte diff so whitespace drift cannot hide.
  return firstRouteDifference(source.routes, manifest.routes) ?? firstByteDifference(expected, actual)
}

/** Compare the freshly collected manifest with the tracked files and describe
 * the first difference. Reads only: `--check` never rewrites the artifacts. */
export async function checkRouteManifest(root = rootDirectory) {
  const routes = await collectRoutes(root)
  const problems = []
  for (const [name, expected] of renderRouteManifest(routes)) {
    const file = `${manifestDirectory}/${name}`
    const actual = await readFile(join(root, manifestDirectory, name), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (actual === null) { problems.push(`${file} is missing`); continue }
    if (actual === expected) continue
    problems.push(name.endsWith('.json') ? `${file} ${firstJsonDifference(expected, actual)}` : `${file} ${firstByteDifference(expected, actual)}`)
  }
  return { inSync: problems.length === 0, routes: routes.length, methods: routes.reduce((count, route) => count + route.methods.length, 0), problems }
}

export async function runCli(argv = process.argv.slice(2), { root = rootDirectory, stdout = process.stdout, stderr = process.stderr } = {}) {
  const unknown = argv.filter(argument => argument !== '--check')
  if (unknown.length) { stderr.write(`${usage}\nUnsupported argument: ${unknown.join(' ')}\n`); return 2 }
  if (!argv.includes('--check')) {
    const routes = await generateRoutes(root)
    stdout.write(`${JSON.stringify({ routes: routes.length, methods: routes.reduce((count, route) => count + route.methods.length, 0) })}\n`)
    return 0
  }
  const { inSync, routes, methods, problems } = await checkRouteManifest(root)
  if (inSync) { stdout.write(`${JSON.stringify({ check: 'in-sync', manifestNames, routes, methods })}\n`); return 0 }
  stderr.write([`Route manifest is out of date with the route sources:`, ...problems.map(problem => `  ${problem}`), 'Regenerate with: node apps/api/scripts/generate-routes.mjs', ''].join('\n'))
  return 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runCli()
