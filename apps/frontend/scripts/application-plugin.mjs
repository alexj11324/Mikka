import { frontendRuntimeSource } from './frontend-runtime.mjs'
import { builtinModules } from 'node:module'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { overlayAliases, resolveOverlaySpecifier } from '../../../lib/ui-overlay.mjs'
import { actionReferences, actionSignatures, nativeOfflineView, bundledIconCatalogue, bundledSyntaxCatalogue } from '../../desktop/scripts/renderer-transforms.mjs'

export const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const repository = resolve(frontend, '../..')
const renderer = resolve(repository, 'apps/desktop/src/renderer')
const actionDirectory = resolve(repository, 'app/actions')
const slash = value => value.split(sep).join('/')
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]))
const virtualAction = '\0mikka:action:'
const commonAliases = new Map([
  ['next/navigation', 'next-navigation.ts'], ['next/link', 'next-link.tsx'], ['next/dynamic', 'dynamic.tsx'],
  ['@/i18n/navigation', 'i18n-navigation.tsx'],
])
const desktopAliases = new Map([
  ['@/lib/auth-client', 'auth-client.ts'], ['@/components/auth-form', 'auth-form.tsx'],
  ['@/lib/platform/open-settings', 'open-settings.ts'], ['@/lib/platform/client-config', 'client-config.ts'],
  ['@/hooks/use-feature-availability', 'feature-availability.ts'], ['@/lib/live/browser-runtime', 'live-runtime.ts'],
  ['@/lib/computer/request', 'computer-request.ts'], ['@novnc/novnc/lib/rfb.js', 'novnc.ts'],
])

export function serverSpecifier(source) {
  return source === 'server-only' || source === 'next-intl/server' || source.startsWith('node:') || builtins.has(source)
    || /^next\/(?:headers|server|font)(?:\/|$)/.test(source)
    || source === 'better-auth' || source === 'pg' || source === 'postgres'
}

function serverFile(filename) {
  const path = slash(relative(repository, filename.split('?')[0]))
  return path.startsWith('app/api/') || /^lib\/(?:auth|db|session)\.ts$/.test(path) || path.startsWith('lib/db/')
    || /^lib\/desktop-rpc\/(?:registry|schemas|handler|bootstrap|authentication|session(?:-cache(?:-context)?)?)\.ts$/.test(path)
    || /\/next\/dist\/(?:server|compiled\/webpack)/.test(slash(filename))
}

/** Read the literal registry without evaluating any server action or module. */
export function registryActionNames(source) {
  const file = ts.createSourceFile('registry.ts', source, ts.ScriptTarget.Latest, true)
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'functions') continue
      const value = ts.isSatisfiesExpression(declaration.initializer) ? declaration.initializer.expression : declaration.initializer
      if (!value || !ts.isObjectLiteralExpression(value)) throw new Error('FRONTEND_RPC_REGISTRY_LITERAL_REQUIRED')
      return new Set(value.properties.map(property => {
        if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name)) throw new Error('FRONTEND_RPC_REGISTRY_LITERAL_REQUIRED')
        return property.name.text
      }))
    }
  }
  throw new Error('FRONTEND_RPC_REGISTRY_LITERAL_REQUIRED')
}

// Reuse the already tested source transformations; this small adapter captures
// their pure file loaders, without running an esbuild application compilation.
function fileLoader(plugin) {
  let loader
  plugin.setup({ onResolve() {}, onLoad(options, load) { loader = { filter: options.filter, load } } })
  if (!loader) throw new Error('FRONTEND_SOURCE_LOADER_MISSING')
  return loader
}

export async function applicationPlugin(target, { deploymentId = '' } = {}) {
  if (!['web', 'desktop'].includes(target)) throw new Error('FRONTEND_TARGET_INVALID')
  const allowed = registryActionNames(await readFile(resolve(repository, 'lib/desktop-rpc/registry.ts'), 'utf8'))
  const actions = new Map()
  const inputs = new Set()
  const offline = fileLoader(nativeOfflineView())
  const catalogues = [fileLoader(bundledIconCatalogue()), fileLoader(bundledSyntaxCatalogue())]
  const webRpc = resolve(frontend, 'src/web/rpc.ts')
  // UI slots and the hosted layer's `@hosted/` imports, resolved exactly as the
  // desktop renderer's build resolves them (docs/ui-overlay.md).
  const uiSlots = overlayAliases(repository)
  let development = false
  let inventory
  return {
    name: 'mikka-shared-application', enforce: 'pre',
    api: { inventory: () => inventory },
    configResolved(config) { development = config.command === 'serve' },
    async resolveId(source, importer, options) {
      if (source.startsWith('\0mikka:')) return source
      if (source === 'mikka:platform') return resolve(target === 'desktop' ? renderer : resolve(frontend, 'src/web'), 'platform.tsx')
      if (source === 'mikka:frontend-runtime' || source === 'mikka:native-offline' || source === 'mikka:native-offline.css') return `\0${source}`
      if (source === 'mikka:renderer-build') {
        if (development) return '\0mikka:renderer-build'
        return { id: `/mikka/renderer-build.js${deploymentId ? `?dpl=${encodeURIComponent(deploymentId)}` : ''}`, external: true }
      }
      if (serverSpecifier(source)) throw new Error(`FRONTEND_SERVER_IMPORT: ${source}`)
      const action = /^@\/app\/actions\/([\w-]+)$/.exec(source)
      if (action) return `${virtualAction}${action[1]}`
      const alias = commonAliases.get(source) ?? (target === 'desktop' ? desktopAliases.get(source) : undefined)
      if (alias && importer?.split('?')[0] !== resolve(renderer, alias)) return resolve(renderer, alias)
      if (source === 'next/script') {
        if (target === 'desktop') throw new Error('FRONTEND_DESKTOP_REMOTE_SCRIPT_FORBIDDEN')
        return resolve(frontend, 'src/web/next-script.tsx')
      }
      const candidate = resolveOverlaySpecifier(source, uiSlots) ?? (source.startsWith('@/') ? resolve(repository, source.slice(2)) : source)
      // Keep require-call/import semantics when resolving conditional package
      // exports; a CommonJS helper must not become an ESM namespace object.
      const resolved = await this.resolve(candidate, importer, { ...options, skipSelf: true })
      if (!resolved) return null
      const id = resolved.id.split('?')[0]
      if (serverFile(id)) throw new Error(`FRONTEND_SERVER_MODULE: ${slash(relative(repository, id))}`)
      if (target === 'web' && id === resolve(renderer, 'rpc.ts') && importer?.split('?')[0] !== webRpc) return webRpc
      if (isAbsolute(id) && dirname(id) === actionDirectory && id.endsWith('.ts')) return `${virtualAction}${id.slice(actionDirectory.length + 1, -3)}`
      return resolved
    },
    async load(id) {
      if (id === '\0mikka:frontend-runtime') {
        return frontendRuntimeSource(target, { development, frontend, renderer })
      }
      if (id === '\0mikka:renderer-build') return 'export const rendererBuild = "development";'
      if (id === '\0mikka:native-offline' || id === '\0mikka:native-offline.css') return (await offline.load({ path: id.slice(1) })).contents
      if (!id.startsWith(virtualAction)) return null
      const name = id.slice(virtualAction.length)
      const signatures = actionSignatures(await readFile(resolve(actionDirectory, `${name}.ts`), 'utf8'), name)
      actions.set(name, signatures.map(value => value.name))
      const rpc = target === 'desktop' ? resolve(renderer, 'rpc.ts') : webRpc
      return `import { callAction } from ${JSON.stringify(rpc)};\n${signatures.map(({ name: action, arity, rest }) => `export const ${action} = (...args) => callAction(${JSON.stringify(`${name}.${action}`)}, ${rest ? 'args' : arity ? `args.slice(0, ${arity})` : '[]'});`).join('\n')}\n`
    },
    async transform(code, id) {
      const filename = id.split('?')[0]
      if (serverFile(filename) || /^\s*['"]use server['"]\s*;?/.test(code)) throw new Error('FRONTEND_SERVER_MODULE')
      if (isAbsolute(filename) && !filename.includes('node_modules') && /\.[cm]?[jt]sx?$/.test(filename)) inputs.add(filename)
      for (const catalogue of catalogues) if (catalogue.filter.test(filename)) return { code: (await catalogue.load({ path: filename })).contents, map: null }
      return null
    },
    async generateBundle() {
      const used = new Set()
      for (const path of inputs) for (const name of actionReferences(await readFile(path, 'utf8'), path)) used.add(name)
      const missing = [...used].filter(name => !allowed.has(name)).sort()
      if (missing.length) throw new Error(`FRONTEND_ACTION_NOT_ALLOWED: ${missing.join(', ')}`)
      const modules = Object.fromEntries([...actions].sort(([a], [b]) => a.localeCompare(b)))
      inventory = {
        version: 1, target, modules, exports: Object.values(modules).reduce((sum, names) => sum + names.length, 0),
        usedActions: [...used].sort(), sourceActions: (await readdir(actionDirectory)).filter(name => name.endsWith('.ts')).length,
        inputs: [...inputs].map(path => slash(relative(repository, path))).sort(), serverModules: [],
      }
    },
  }
}
