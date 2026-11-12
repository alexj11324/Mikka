// PR #1559 § 8 / #1571: independently runnable core and cloud clients stay
// public; the service that owns Mikka's credentials lives in mikka-cloud.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

export const cloudBoundaryMessage = 'New Mikka Cloud credential issuance, cross-server brokers and metering belong in the private mikka-cloud repository (PR #1559 § 8 / #1571). Keep public clients, contracts and independently runnable core here.'
const self = 'scripts/cloud-boundary-policy.mjs'
const privateEnvironment = /^MIKKA_CLOUD_(?:SIGNING(?:_KEYS?|_PRIVATE_KEY|_KEY_ID)?|(?:JWT|JWKS)_PRIVATE_KEY|PRIVATE_JWKS?|DATA_KEY|GITHUB_APP_PRIVATE_KEY|EXPO_ACCESS_TOKEN)$/
const privatePackage = /^(?:@mikka\/cloud-server|mikka-cloud)(?:\/|$)/
const privateRoute = /^\/v1\/(?:servers|server-keys|github|push|models|model-sessions|decisions|usage)(?:\/|$)/
const issuerRoute = /^\/(?:oauth\/(?:authorize|token|revoke)|\.well-known\/jwks\.json)$/
const cloudSchema = /\b(?:(?:FROM|JOIN|INTO|UPDATE|REFERENCES)\s+|(?:TABLE|SCHEMA)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?)"?cloud"?(?:\s*\.\s*(?:"?[a-z_][a-z_0-9]*"?|__expression__)|(?=\s|;|$))/ig
const installationToken = /\/(?:app\/)?installations\/[^\s'"`]{1,300}\/access_tokens\b/g
const expoEndpoint = /https:\/\/(?:exp\.host|api\.expo\.dev)\/--\/api\/v2\/push(?:\/(?:send|getReceipts))?\b/g
const cryptoSigners = new Set(['sign', 'createSign', 'generateKeyPair', 'generateKeyPairSync', 'createPrivateKey'])
const routeMethods = new Set(['get', 'post', 'put', 'delete', 'patch', 'route', 'on', 'use'])
const meterTable = /(?:^|[_.])(?:usage|meter|metering|billing|charges|quota|model_sessions?)(?:_|$)/i

const fingerprint = (rule, text) => createHash('sha256').update(`${rule}\0${text.replace(/\s+/g, ' ').trim()}`).digest('hex')
const legacy = (rule, text, reason, hits = 1) => ({ rule, fingerprint: fingerprint(rule, text), hits, reason })

/** No whole-file exemptions. Each retained primitive has its own fingerprint
 * and exact count: moving it, adding another, or leaving a stale entry fails.
 * These exceptions do not exempt private cloud tables, issuers or relays. */
export const cloudBoundaryAllowlist = {
  'scripts/private-source-auth.mjs': [
    legacy('cloud/github-token-mint', '/app/installations/__expression__/access_tokens',
      'Public-owned Cloud Services and marketing builds mint repository-scoped contents-read checkout tokens with the existing GitHub App.'),
    legacy('cloud/token-issuer', "createSign('RSA-SHA256')",
      'Build-only GitHub App JWT authenticates the two fixed private source checkouts for public-owned builds.'),
  ],
  'lib/mobile-push-delivery.ts': [legacy('cloud/privileged-expo-delivery', 'https://exp.host/--/api/v2/push',
    'Existing first-party push delivery and receipt checks remain public under PR #1559 § 8; this shared base serves only this deployment, while community clients call the separate cloud relay.')],
  'scripts/dev-local/services.mjs': [legacy('cloud/service-route', '/v1/decisions',
    'Existing deterministic local API/CLI acceptance fixture under /gateway; it neither proxies a hosted model nor meters another server.')],
}

const name = node => node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : null
function constant(node) {
  if (!node) return null
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(span => `${constant(span.expression) ?? '__expression__'}${span.literal.text}`).join('')
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = constant(node.left), right = constant(node.right)
    if (left !== null && right !== null) return left + right
  }
  return null
}

/** AST inspection ignores prose/comments and distinguishes a request's route
 * handler from a client calling the same documented URL. It is a mechanical
 * boundary for known primitives, not a proof of arbitrary program semantics. */
export function findCloudBoundary(file, source) {
  const found = [], seen = new Set()
  const add = (index, rule, text) => {
    const key = `${index}:${rule}`
    if (seen.has(key)) return
    seen.add(key)
    const before = source.slice(0, index)
    found.push({ file, line: before.split('\n').length, column: index - before.lastIndexOf('\n'), rule,
      fingerprint: fingerprint(rule, text), message: cloudBoundaryMessage })
  }
  const inspectText = (text, index) => {
    if (privateEnvironment.test(text)) add(index, 'cloud/private-environment', text)
    for (const match of text.matchAll(cloudSchema)) add(index + match.index, 'cloud/private-schema', match[0])
    for (const match of text.matchAll(installationToken)) add(index + match.index, 'cloud/github-token-mint', match[0])
    for (const match of text.matchAll(expoEndpoint)) add(index + match.index, 'cloud/privileged-expo-delivery', match[0])
    // A renamed schema/table cannot hide an explicitly server-keyed meter.
    const table = /\b(?:INSERT\s+INTO|UPDATE|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+(["\w.]+)/i.exec(text)?.[1]?.replaceAll('"', '')
    if (table && meterTable.test(table) && /\bserver_?id\b/i.test(text)) add(index, 'cloud/cross-server-meter', table)
  }
  if (/\.sql$/i.test(file)) {
    const sql = source.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
    inspectText(sql, 0)
    return found
  }
  if (/(?:^|\/)package\.json$/.test(file)) {
    let pkg
    try { pkg = JSON.parse(source) } catch { return found }
    if (privatePackage.test(String(pkg.name ?? ''))) add(source.indexOf('"name"'), 'cloud/private-package', pkg.name)
    for (const group of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [dependency, value] of Object.entries(pkg[group] ?? {})) {
        if (privatePackage.test(dependency) || /(?:github\.com[:/]|github:)alexj11324\/mikka-cloud(?:[.#/]|$)/i.test(String(value))) {
          add(source.indexOf(JSON.stringify(dependency)), 'cloud/private-package', dependency)
        }
      }
    }
    return found
  }
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
    /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const declarations = tree.statements.filter(ts.isImportDeclaration)
  if (declarations.some(node => /^(?:node:test|vitest|bun:test|@playwright\/test)$/.test(constant(node.moduleSpecifier) ?? ''))) return []
  const signerNames = new Set(), jwtNames = new Set(), cryptoNamespaces = new Set()
  for (const declaration of declarations) {
    const module = constant(declaration.moduleSpecifier) ?? ''
    if (privatePackage.test(module)) add(declaration.getStart(tree), 'cloud/private-package', module)
    const bindings = declaration.importClause?.namedBindings
    if (bindings && ts.isNamespaceImport(bindings) && /^(?:node:)?crypto$/.test(module)) cryptoNamespaces.add(bindings.name.text)
    if (declaration.importClause?.name && module === 'jsonwebtoken') jwtNames.add(declaration.importClause.name.text)
    if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text
      if (/^(?:node:)?crypto$/.test(module) && cryptoSigners.has(imported)) signerNames.add(element.name.text)
      if (module === 'jose' && imported === 'SignJWT') jwtNames.add(element.name.text)
    }
  }
  let cloudContext = false
  const context = node => {
    const value = constant(node)
    if (value && /\bmikka-cloud\b|\bMIKKA_CLOUD_|\bcloud\.signing_keys\b/i.test(value)
      || ts.isIdentifier(node) && node.text.startsWith('MIKKA_CLOUD_')) cloudContext = true
    ts.forEachChild(node, context)
  }
  context(tree)
  const isPrivateRoute = value => privateRoute.test(value) || cloudContext && issuerRoute.test(value)
  const visit = node => {
    const position = node.getStart(tree)
    if (ts.isIdentifier(node) && privateEnvironment.test(node.text)) add(position, 'cloud/private-environment', node.text)
    const value = constant(node)
    if (value !== null) inspectText(value, position)
    if (ts.isObjectLiteralExpression(node)) {
      const properties = node.properties.filter(ts.isPropertyAssignment)
      const field = key => properties.find(property => name(property.name) === key)
      if (field('kty') && field('d') && field('d').initializer.getText(tree) !== 'undefined') add(position, 'cloud/private-jwk', node.getText(tree))
      const route = constant(field('path')?.initializer)
      if (route && isPrivateRoute(route) && (field('handle') || field('handler'))) add(position, 'cloud/service-route', route)
      const signature = field('Mikka-Cloud-Signature')
      if (signature) add(signature.getStart(tree), 'cloud/github-webhook-forward', signature.getText(tree))
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const call = node.expression
      const method = ts.isPropertyAccessExpression(call) ? call.name.text : ts.isIdentifier(call) ? call.text : ''
      const args = node.arguments ?? []
      if (['require', 'import'].includes(method) || call.kind === ts.SyntaxKind.ImportKeyword) {
        const module = constant(args[0]); if (module && privatePackage.test(module)) add(position, 'cloud/private-package', module)
      }
      if (['pgSchema', 'createSchema'].includes(method) && constant(args[0]) === 'cloud') add(position, 'cloud/private-schema', node.getText(tree))
      if (method === 'createInstallationAccessToken') add(position, 'cloud/github-token-mint', node.getText(tree))
      if (['sendPushNotificationsAsync', 'getPushNotificationReceiptsAsync'].includes(method)) add(position, 'cloud/privileged-expo-delivery', node.getText(tree))
      if (method === 'set' && constant(args[0]) === 'Mikka-Cloud-Signature') add(position, 'cloud/github-webhook-forward', node.getText(tree))
      if (routeMethods.has(method)) for (const argument of args) {
        const route = constant(argument); if (route && isPrivateRoute(route)) add(position, 'cloud/service-route', route)
      }
      const receiver = ts.isPropertyAccessExpression(call) ? call.expression.getText(tree) : ''
      if (cloudContext && (signerNames.has(method) || jwtNames.has(method)
        || cryptoNamespaces.has(receiver) && cryptoSigners.has(method)
        || jwtNames.has(receiver) && method === 'sign')) add(position, 'cloud/token-issuer', node.getText(tree))
    }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken].includes(node.operatorToken.kind)) {
      for (const [value, target] of [[constant(node.left), node.right], [constant(node.right), node.left]]) {
        if (value && isPrivateRoute(value) && /(?:^|\.)path(?:name)?$/.test(target.getText(tree))) add(position, 'cloud/service-route', value)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  if (/(?:^|\/)mikka-cloud\//.test(file)) add(0, 'cloud/private-service-tree', file)
  if (/^(?:app|apps\/api\/routes)\/(?:api\/)?(?:cloud\/)?v1\/(?:servers|server-keys|github|push|models|model-sessions|decisions|usage)(?:\/|\.)/.test(file)) add(0, 'cloud/service-route', file)
  return found.sort((a, b) => a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule))
}

export function auditCloudBoundary(file, source, allowlist = cloudBoundaryAllowlist) {
  const found = findCloudBoundary(file, source), entries = allowlist[file] ?? []
  return found.filter(finding => !entries.some(entry => entry.rule === finding.rule && entry.fingerprint === finding.fingerprint
    && found.filter(other => other.rule === entry.rule && other.fingerprint === entry.fingerprint).length === entry.hits))
}

export function cloudBoundaryPolicyFiles(root = process.cwd()) {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(file => file && file !== self
      && (/\.(?:[cm]?[jt]sx?|sql)$/.test(file) || /(?:^|\/)package\.json$/.test(file))
      && !/(?:^|\/)(?:node_modules|\.next|dist|out|build|__tests__|tests?|e2e|__fixtures__|fixtures|\.claude|\.codex)\//.test(file)
      && !/\.(?:test|spec|fixture|stories)\.[cm]?[jt]sx?$/.test(file) && !file.endsWith('.d.ts') && existsSync(resolve(root, file)))
}

export function staleCloudBoundaryEntries(root = process.cwd(), allowlist = cloudBoundaryAllowlist) {
  return Object.entries(allowlist).flatMap(([file, entries]) => {
    if (!existsSync(resolve(root, file))) return [`${file}: file no longer exists; remove its cloud boundary exception`]
    const found = findCloudBoundary(file, readFileSync(resolve(root, file), 'utf8'))
    return entries.flatMap(entry => {
      if (!entry.reason || entry.reason.length < 20 || !Number.isInteger(entry.hits) || entry.hits < 1) return [`${file}: cloud boundary exception needs an exact positive count and a reason`]
      const count = found.filter(finding => finding.rule === entry.rule && finding.fingerprint === entry.fingerprint).length
      return count < entry.hits ? [`${file}: stale cloud boundary exception for ${entry.rule}; expected ${entry.hits}, found ${count}`] : []
    })
  })
}

export function auditCloudRepository(root = process.cwd(), allowlist = cloudBoundaryAllowlist) {
  return { findings: cloudBoundaryPolicyFiles(root).flatMap(file => auditCloudBoundary(file, readFileSync(resolve(root, file), 'utf8'), allowlist)),
    stale: staleCloudBoundaryEntries(root, allowlist) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = auditCloudRepository()
  for (const finding of result.findings) console.error(`${finding.file}:${finding.line}:${finding.column} ${finding.rule}: ${finding.message}`)
  for (const stale of result.stale) console.error(stale)
  if (result.findings.length || result.stale.length) process.exitCode = 1
  else console.log('cloud boundary: public core and clients pass; no private cloud service primitives added')
}
