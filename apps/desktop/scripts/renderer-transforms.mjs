import postcss from 'postcss'
import ts from 'typescript'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repository = resolve(desktop, '../..')
const renderer = resolve(desktop, 'src/renderer')
const actionDirectory = resolve(repository, 'app/actions')

/** Export names come from the same source the web compiles, never a manually
 * maintained second application. Type-only exports disappear in both builds. */
export function actionExports(source, filename) {
  return actionSignatures(source, filename).map(action => action.name)
}

export function actionSignatures(source, filename) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true)
  return file.statements.flatMap(statement => {
    const exported = statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
    if (!exported || !ts.isFunctionDeclaration(statement) || !statement.name) return []
    if (!statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
      throw new Error(`Desktop action must be async: ${filename}.${statement.name.text}`)
    }
    return [{ name: statement.name.text, arity: statement.parameters.length, rest: statement.parameters.some(parameter => Boolean(parameter.dotDotDotToken)) }]
  })
}

/** Every application action import is replaced before module loading. The
 * server's separately validated allowlist is the authority for dispatch. */
export function applicationBoundary(actions) {
  const aliases = new Map([
    ['next/navigation', 'next-navigation.ts'],
    ['next/link', 'next-link.tsx'],
    ['next/dynamic', 'dynamic.tsx'],
    ['@/i18n/navigation', 'i18n-navigation.tsx'],
    ['@/lib/auth-client', 'auth-client.ts'],
    ['@/components/auth-form', 'auth-form.tsx'],
    ['@/lib/platform/open-settings', 'open-settings.ts'],
    ['@/lib/platform/client-config', 'client-config.ts'],
    ['@/hooks/use-feature-availability', 'feature-availability.ts'],
    ['@/lib/live/browser-runtime', 'live-runtime.ts'],
    ['@/lib/computer/request', 'computer-request.ts'],
    ['@novnc/novnc/lib/rfb.js', 'novnc.ts'],
  ])
  return {
    name: 'mikka-desktop-application-boundary',
    setup(builder) {
      // This small local module is written from the finished output's hash.
      // Keep APP_BUILD empty: the shared web deployment checker must not poll
      // or reload an installed renderer when its backend deployment changes.
      builder.onResolve({ filter: /^mikka:renderer-build$/ }, () => ({ path: '/mikka/renderer-build.js', external: true }))
      builder.onResolve({ filter: /^(?:next\/|@\/|@novnc\/)/ }, args => {
        const replacement = aliases.get(args.path)
        // These two adapters delegate unchanged non-viewer behavior to the
        // original module; only their own imports bypass the alias.
        if (replacement && args.importer !== resolve(renderer, replacement)) return { path: resolve(renderer, replacement) }
        const match = /^@\/app\/actions\/([\w-]+)$/.exec(args.path)
        if (match) return { path: match[1], namespace: 'desktop-action' }
        if (args.path === 'next/headers' || args.path === 'next/server' || args.path.startsWith('next/font/')) {
          return { errors: [{ text: `Server-only import in desktop renderer: ${args.path} from ${args.importer}` }] }
        }
        return null
      })
      builder.onResolve({ filter: /^(?:server-only|next-intl\/server|node:)/ }, args => ({
        errors: [{ text: `Server-only import in desktop renderer: ${args.path} from ${args.importer}` }],
      }))
      builder.onLoad({ filter: /.*/, namespace: 'desktop-action' }, async args => {
        const filename = resolve(actionDirectory, `${args.path}.ts`)
        const signatures = actionSignatures(await readFile(filename, 'utf8'), args.path)
        const names = signatures.map(action => action.name)
        actions.set(args.path, names)
        return {
          // SWR calls a zero-argument fetcher with its cache key. The original
          // function ignores extra arguments; its transport stub must do too.
          contents: `import { callAction } from ${JSON.stringify(resolve(renderer, 'rpc.ts'))};\n${signatures.map(({ name, arity, rest }) => `export const ${name} = (...args) => callAction(${JSON.stringify(`${args.path}.${name}`)}, ${rest ? 'args' : arity ? `args.slice(0, ${arity})` : '[]'});`).join('\n')}\n`,
          loader: 'js',
          resolveDir: repository,
        }
      })
    },
  }
}

/** The installed fallback owns this presentation. Read its real CSS and SVG
 * paths instead of maintaining a second offline design in the React app. */
export function nativeOfflineView() {
  return {
    name: 'mikka-native-offline-view',
    setup(builder) {
      builder.onResolve({ filter: /^mikka:native-offline(?:\.css)?$/ }, args => ({ path: args.path, namespace: 'native-offline' }))
      builder.onLoad({ filter: /.*/, namespace: 'native-offline' }, async args => {
        const source = await readFile(resolve(desktop, 'src/offline.html'), 'utf8')
        if (args.path.endsWith('.css')) {
          const styles = /<style>([\s\S]*?)<\/style>/.exec(source)?.[1]
          if (!styles) throw new Error('Native offline styles are missing')
          const css = postcss.parse(styles)
          css.walkRules(rule => {
            if (rule.parent?.type === 'atrule' && rule.parent.name.includes('keyframes')) return
            rule.selectors = rule.selectors.flatMap(selector => {
              if (selector === ':root' || selector === 'body') return ['.desktop-offline']
              if (selector === '*') return ['.desktop-offline', '.desktop-offline *']
              if (selector === 'main') return ['.desktop-offline section']
              return [`.desktop-offline ${selector}`]
            })
          })
          css.walkAtRules('keyframes', rule => { rule.params = `desktop-offline-${rule.params}` })
          css.walkDecls('animation', declaration => { declaration.value = declaration.value.replace(/^pulse\b/, 'desktop-offline-pulse') })
          return { contents: css.toString(), loader: 'css' }
        }
        const paths = Object.fromEntries(['network', 'server'].map(kind => {
          const svg = new RegExp(`<svg id="icon-${kind}"[^>]*>([\\s\\S]*?)<\\/svg>`).exec(source)?.[1]
          const values = [...(svg ?? '').matchAll(/<path d="([^"]+)"\s*\/>/g)].map(match => match[1])
          if (!values.length) throw new Error(`Native offline ${kind} icon is missing`)
          return [kind, values]
        }))
        return { contents: `import 'mikka:native-offline.css'; export const paths = ${JSON.stringify(paths)};`, loader: 'js' }
      })
    },
  }
}

/** OpenUI's icon catalogue has ~2,000 dynamic entry points, although it uses
 * the same Lucide modules the application already imports. Keep its exact
 * names and Promise/module contract while sharing one local icon catalogue;
 * thousands of tiny scheme requests would otherwise dominate a cold launch. */
export function bundledIconCatalogue() {
  return {
    name: 'mikka-bundled-icon-catalogue',
    setup(builder) {
      builder.onLoad({ filter: /[\\/]lucide-react[\\/]dist[\\/]esm[\\/]dynamicIconImports\.(?:mjs|js)$/ }, async args => {
        const source = await readFile(args.path, 'utf8')
        const imports = []
        const modules = new Map()
        const contents = source.replace(/\(\) => import\('([^']+)'\)/g, (_match, path) => {
          if (!modules.has(path)) {
            const name = `icon${modules.size}`
            modules.set(path, name)
            imports.push(`import * as ${name} from ${JSON.stringify(path)};`)
          }
          return `() => Promise.resolve(${modules.get(path)})`
        })
        if (!modules.size) throw new Error('Lucide dynamic catalogue format changed')
        return { contents: `${imports.join('\n')}\n${contents}`, loader: 'js', resolveDir: dirname(args.path) }
      })
    },
  }
}

export function bundledSyntaxCatalogue() {
  return {
    name: 'mikka-bundled-syntax-catalogue',
    setup(builder) {
      builder.onLoad({ filter: /[\\/]react-syntax-highlighter[\\/]dist[\\/]esm[\\/]async-languages[\\/](?:prism|hljs)\.js$/ }, async args => {
        const source = await readFile(args.path, 'utf8')
        const imports = []
        const contents = source.replace(/import\(\s*(?:\/\*[\s\S]*?\*\/\s*)?["']([^"']+)["']\s*\)/g, (_match, path) => {
          const name = `language${imports.length}`
          imports.push(`import * as ${name} from ${JSON.stringify(path)};`)
          return `Promise.resolve(${name})`
        })
        if (!imports.length) throw new Error('Syntax-highlighter catalogue format changed')
        return { contents: `${imports.join('\n')}\n${contents}`, loader: 'js', resolveDir: dirname(args.path) }
      })
    },
  }
}

/** Named re-exports are real consumers too: the billing adapter forwards its
 * existing actions through a client-only module. Type-only bindings disappear. */
export function actionReferences(source, filename) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true)
  const imports = new Set()
  for (const statement of file.statements) {
    const imported = ts.isImportDeclaration(statement)
    const exported = ts.isExportDeclaration(statement)
    if ((!imported && !exported) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    if ((imported && statement.importClause?.isTypeOnly) || (exported && statement.isTypeOnly)) continue
    const match = /^@\/app\/actions\/([\w-]+)$/.exec(statement.moduleSpecifier.text)
    const bindings = imported ? statement.importClause?.namedBindings : statement.exportClause
    if (!match || !bindings || (!ts.isNamedImports(bindings) && !ts.isNamedExports(bindings))) continue
    for (const binding of bindings.elements) if (!binding.isTypeOnly) imports.add(`${match[1]}.${binding.propertyName?.text ?? binding.name.text}`)
  }
  return [...imports].sort()
}

export async function usedActionImports(inputs) {
  const imports = new Set()
  for (const path of inputs.filter(name => /\.[cm]?[jt]sx?$/.test(name) && !name.includes('node_modules'))) {
    for (const name of actionReferences(await readFile(resolve(repository, path), 'utf8'), path)) imports.add(name)
  }
  return [...imports].sort()
}
