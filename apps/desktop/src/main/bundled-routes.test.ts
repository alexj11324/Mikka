import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { allowedApiPath } from './bundled-policy'

// The main process allowlists API routes by hand (bundled-policy.ts), so a route
// the shared UI adds is silently denied in the desktop build until someone edits
// that table: 收件箱 (#2843), the pull-request panel, the machine list in the new
// session dialog. This walks the renderer's own call sites instead, so the table
// has to keep up. The scan is a lower bound — it follows `fetch`, `withBasePath`
// and a module's own request helpers, not a helper imported from elsewhere.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const SKIP = new Set(['node_modules', 'dist', '.next', '.turbo'])
/**
 * Modules the frontend build refuses to put in the renderer at all — the same
 * rule as `serverFile()` in apps/frontend/scripts/application-plugin.mjs.
 */
const SERVER_MODULE = /^(?:lib\/(?:auth|db|session)\.ts|lib\/db\/|lib\/desktop-rpc\/(?:registry|schemas|handler|bootstrap|authentication|session(?:-cache(?:-context)?)?)\.ts)/

/**
 * Routes the renderer names but the desktop build does not serve, each with the
 * reason, so the boundary is written down instead of assumed. Everything else
 * the renderer asks for must be on the allowlist: a new route fails here until
 * bundled-policy.ts covers it, or until it earns an entry like these.
 */
const NOT_SERVED: Record<string, string> = {
  '/api/desktop/begin': 'the desktop build replaces @/components/auth-form; sign-in opens in the system browser',
  '/api/test-workspace': 'dev-only workspace bootstrap in the web sign-in form',
  '/api/auth': 'the allowlist forwards no better-auth traffic: sign-in, consent and recovery run in the system browser or the main process',
  '/api/auth/*': 'account recovery and sign-out are web pages, not renderer requests',
  '/api/auth/sign-in/sso': 'company sign-in hands off to the system browser',
  '/api/auth/sso/oidc/logout/*': 'SSO sign-out is a browser redirect',
  '/api/enterprise/link': 'the enterprise sign-in link is opened in the system browser',
  '/api/github/manifest': 'GitHub App manifests need a public callback URL, so the flow stays on the web',
  '/api/cloud/*': 'managed-cloud connect and disconnect belong to the hosted product',
  '/api/integrations/google/callback': 'provider callback URL for the Google link, completed by the browser',
  '/api/integrations/github/install': 'the install page link is opened at github.com',
  '/api/live/ticket': 'the desktop build swaps in its own live runtime through @/lib/live/browser-runtime',
  '/api/mcp': 'the MCP resource URL is advertised to MCP clients; the renderer never requests it',
  '/api/web/return': 'the web sign-in return has no meaning inside the desktop window',
}

const UUID = '84c182d1-661c-461b-bca2-10410cb646d4'
const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const LOGIN_SAMPLES = ['preferences', 'sessions', 'bots', 'usage']
/** The last resort for a hole no matching route explains: a plain id, then anything goes. */
const UNTYPED = [UUID, ULID, 'abc123', '1']

type Route = { template: string }
type CallSite = { path: string; methods: Set<string>; files: Set<string> }

/** The generated route table is the repository's own list of routes (apps/api/generated/routes.json). */
const routes: Route[] = (JSON.parse(readFileSync(join(repository, 'apps/api/generated/routes.json'), 'utf8')) as { routes: Route[] }).routes

const segments = (path: string) => path.split('/')

/** The manifest routes a call site could name: same depth, every literal segment equal. */
function matchingRoutes(path: string): Route[] {
  const parts = segments(path)
  return routes.filter(route => {
    const candidate = segments(route.template)
    return candidate.length === parts.length && candidate.every((segment, index) => parts[index] === '\u0000' || segment === parts[index])
  })
}

/** A parameter's name says what the route expects there, so the sample is a value it would accept. */
function sampleFor(parameter: string): string[] {
  if (/volume/i.test(parameter)) return [`vol_${ULID}`, ULID]
  if (/version/i.test(parameter)) return [`vver_${ULID}`, ULID]
  if (/hash|sha256|digest/i.test(parameter)) return ['a'.repeat(64), ULID]
  if (/name|key|section|provider|app|toolkit|locale/i.test(parameter)) return [...LOGIN_SAMPLES, UUID]
  return [UUID, ULID, 'abc123', '1']
}

/**
 * What a call site's holes may hold: the literal segments the matching routes
 * put there, the value their parameter name asks for, then a plain id.
 */
function valuesAt(index: number, matches: Route[]): string[] {
  const literal = matches.map(route => segments(route.template)[index]!).filter(segment => !segment.startsWith('['))
  const parameter = matches.map(route => segments(route.template)[index]!).find(segment => segment.startsWith('['))
  const typed = parameter ? sampleFor(parameter.replace(/[[\].]/g, '')) : []
  return [...new Set([...literal, ...typed, ...UNTYPED])]
}

/** Concrete paths for a call site's holes, so the allowlist sees what the renderer really sends. */
function samples(path: string): string[] {
  const parts = segments(path)
  const holes = parts.flatMap((part, index) => (part === '\u0000' ? [index] : []))
  if (!holes.length) return [parts.join('/')]
  const matches = matchingRoutes(path)
  const choices = holes.map(index => valuesAt(index, matches))
  const fill = (picked: number[]) => parts.map((part, index) => {
    const hole = holes.indexOf(index)
    return hole === -1 ? part : choices[hole]![picked[hole]!]!
  }).join('/')
  const picked = holes.map(() => 0)
  const paths = [fill(picked)]
  for (let hole = 0; hole < holes.length; hole++) {
    for (let pick = 1; pick < choices[hole]!.length; pick++) {
      paths.push(fill(picked.map((value, index) => (index === hole ? pick : value))))
    }
  }
  return paths
}

function sources(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) sources(path, found)
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) found.push(path)
  }
  return found
}

/**
 * The renderer bundles `components/`, `hooks/` and the desktop renderer itself,
 * then whatever `lib/` modules they import — the rest of `lib/` is server code.
 */
function rendererSources(): string[] {
  const roots = ['components', 'hooks', 'apps/desktop/src/renderer'].map(root => join(repository, root))
  const included = new Set(roots.flatMap(root => sources(root)).map(file => relative(repository, file).split(sep).join('/')))
  const library = new Map(sources(join(repository, 'lib')).map(file => [relative(repository, file).split(sep).join('/'), file]))
  const specifier = /(?:from|import)\s*\(?\s*['"]@\/((?:lib|components|hooks)\/[^'"]+)['"]/g
  const pending = [...included]
  while (pending.length) {
    const file = pending.pop()!
    for (const match of readFileSync(join(repository, file), 'utf8').matchAll(specifier)) {
      for (const candidate of [match[1]!, `${match[1]}.ts`, `${match[1]}.tsx`, `${match[1]}/index.ts`, `${match[1]}/index.tsx`]) {
        if (!library.has(candidate) || included.has(candidate)) continue
        included.add(candidate)
        pending.push(candidate)
      }
    }
  }
  return [...included].filter(file => !SERVER_MODULE.test(file)).sort()
}

/** The URL a call names, once `withBasePath`, concatenation and assertions are unwrapped. */
function urlOf(node: ts.Node | undefined): ts.Expression | null {
  if (!node) return null
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) return urlOf(node.expression)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return urlOf(node.left)
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'withBasePath') return urlOf(node.arguments[0])
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) return node
  return null
}

function literalText(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (!ts.isTemplateExpression(node)) return null
  return [node.head.text, ...node.templateSpans.map(span => `\u0000${span.literal.text}`)].join('')
}

/** A query string never changes which route a path names. */
const withoutQuery = (path: string) => path.split(/[?#]/, 1)[0]!

/** The HTTP method a request declares — `fetch(url, { method })` or `send(url, 'POST', body)` — defaulting to GET. */
function methodOf(call: ts.CallExpression): string {
  const init = call.arguments[1]
  if (!init) return 'GET'
  if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) return /^(?:GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(init.text) ? init.text : 'GET'
  if (!ts.isObjectLiteralExpression(init)) return 'GET'
  for (const property of init.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || property.name.text !== 'method') continue
    const value = property.initializer
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text.toUpperCase()
  }
  return 'GET'
}

/** Names this module defines around a `fetch`, so a call through `read(path)` counts as a request too. */
function requestFunctions(ast: ts.SourceFile): Set<string> {
  const bodies = new Map<string, ts.Node>()
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) bodies.set(node.name.text, node)
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) bodies.set(node.name.text, node.initializer)
    else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) bodies.set(node.name.text, node)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  const reaches = (node: ts.Node, names: Set<string>) => {
    let found = false
    const scan = (child: ts.Node) => {
      if (found) return
      if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && names.has(child.expression.text)) found = true
      else ts.forEachChild(child, scan)
    }
    scan(node)
    return found
  }
  const requests = new Set<string>()
  for (const [name, body] of bodies) if (reaches(body, new Set(['fetch']))) requests.add(name)
  // A wrapper over a wrapper (`read` → `request` → `fetch`) still makes a request.
  for (let pass = 0; pass < 3; pass++) for (const [name, body] of bodies) if (!requests.has(name) && reaches(body, requests)) requests.add(name)
  return requests
}

/** Every `/api/…` route the renderer requests, keyed by path with its holes kept as `\u0000`. */
function callSites(): Map<string, CallSite> {
  const sites = new Map<string, CallSite>()
  /** A route named by `withBasePath` alone says nothing about the method; the call around it does. */
  const record = (path: string, file: string, method: string | null) => {
    const site = sites.get(path) ?? { path, methods: new Set<string>(), files: new Set<string>() }
    if (method) site.methods.add(method)
    site.files.add(file)
    sites.set(path, site)
  }
  for (const file of rendererSources()) {
    const source = readFileSync(join(repository, file), 'utf8')
    if (!source.includes('/api/')) continue
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const requests = requestFunctions(ast)
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : ''
        const url = urlOf(node.arguments[0])
        const text = url && literalText(url)
        // A route is named either straight (`fetch('/api/x')`) or through the one
        // helper that adds the deployment prefix, or through a module's own reader.
        if (text?.startsWith('/api/') && (name === 'fetch' || name === 'withBasePath' || requests.has(name)) && !navigates(node)) {
          record(withoutQuery(text), file, name === 'withBasePath' ? null : methodOf(node))
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
  for (const site of sites.values()) if (!site.methods.size) site.methods.add('GET')
  return sites
}

/**
 * A route is only checkable when every `${…}` fills a whole path segment: a
 * template that glues one onto a segment (`/definition${kind}`) does not say
 * which route it becomes, and a bare prefix names no route at all.
 */
function checkable(path: string): boolean {
  if (path.endsWith('/')) return false
  const parts = path.split('/')
  return parts.every((part, index) => !part.includes('\u0000') || (part === '\u0000' && index > 0))
}

/**
 * Links, `window.location` and external-browser hand-offs leave the renderer, so
 * the sandbox never sees them: only a request is checked against the allowlist.
 */
function navigates(node: ts.Node): boolean {
  const links = new Set(['assign', 'replace', 'open', 'openExternal', 'navigate'])
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (ts.isJsxAttribute(at) || ts.isJsxOpeningElement(at) || ts.isJsxSelfClosingElement(at)) return true
    if (ts.isPropertyAccessExpression(at) && at.name.text === 'href') return true
    if (ts.isCallExpression(at) && at.expression !== node) {
      const callee = at.expression
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : ''
      if (links.has(name)) return true
    }
    if (ts.isStatement(at) || ts.isFunctionLike(at)) return false
  }
  return false
}

const sites = callSites()
/** A recorded path with its holes written as `*`, so the table above reads as the route it names. */
const key = (path: string) => path.replaceAll('\u0000', '*')
const described = (path: string) => path.replaceAll('\u0000', '${…}')
const asked = new Set([...sites.keys()].map(key))

test('every API route the renderer requests is on the desktop allowlist', () => {
  const denied = [...sites.values()]
    .filter(site => checkable(site.path) && NOT_SERVED[key(site.path)] === undefined)
    .flatMap(site => [...site.methods]
      .filter(method => !samples(site.path).some(path => allowedApiPath(path, method)))
      .map(method => `${method} ${described(site.path)} (${[...site.files].join(', ')})`))
  assert.deepEqual(denied, [], 'bundled-policy.ts denies these renderer routes: add them, or record in NOT_SERVED why the desktop build does not serve them')
})

test('the recorded exceptions still describe a route the renderer asks for', () => {
  assert.deepEqual(Object.keys(NOT_SERVED).filter(path => !asked.has(path)), [], 'stale NOT_SERVED entries: the renderer no longer asks for these')
})

test('the scan sees the panels whose routes drifted before', () => {
  // Guards the scan itself: a broken walk would make the rule above pass for the wrong reason.
  for (const path of ['/api/integrations/github/repositories/pulls', '/api/integrations/github/tools', '/api/bots/*/app-tools', '/api/devices']) {
    assert.ok(asked.has(path), `${path} missing from the scan`)
  }
})
