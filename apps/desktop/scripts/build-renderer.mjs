import { build } from 'esbuild'
import postcss from 'postcss'
import tailwind from '@tailwindcss/postcss'
import ts from 'typescript'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repository = resolve(desktop, '../..')
const renderer = resolve(desktop, 'src/renderer')
const actionDirectory = resolve(repository, 'app/actions')
const slash = path => path.split(sep).join('/')

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
    ['@/lib/live/browser-runtime', 'live-runtime.ts'],
    ['@/lib/computer/request', 'computer-request.ts'],
    ['@novnc/novnc/lib/rfb.js', 'novnc.ts'],
  ])
  return {
    name: 'mikka-desktop-application-boundary',
    setup(builder) {
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

function sharedStyles() {
  return {
    name: 'mikka-shared-tailwind',
    setup(builder) {
      builder.onLoad({ filter: /[\\/]app[\\/]globals\.css$/ }, async args => {
        const css = await readFile(args.path, 'utf8')
        const result = await postcss([tailwind({ base: repository, optimize: true })]).process(css, { from: args.path })
        return { contents: result.css, loader: 'css', resolveDir: dirname(args.path) }
      })
    },
  }
}

/** The installed fallback owns this presentation. Read its real CSS and SVG
 * paths instead of maintaining a second offline design in the React app. */
function nativeOfflineView() {
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
function bundledIconCatalogue() {
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

function bundledSyntaxCatalogue() {
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

async function usedActionImports(inputs) {
  const imports = new Set()
  for (const path of inputs.filter(name => /\.[cm]?[jt]sx?$/.test(name) && !name.includes('node_modules'))) {
    const file = ts.createSourceFile(path, await readFile(resolve(repository, path), 'utf8'), ts.ScriptTarget.Latest, true)
    for (const statement of file.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) continue
      const match = /^@\/app\/actions\/([\w-]+)$/.exec(statement.moduleSpecifier.text)
      const bindings = statement.importClause?.namedBindings
      if (!match || !bindings || !ts.isNamedImports(bindings)) continue
      for (const imported of bindings.elements) if (!imported.isTypeOnly) imports.add(`${match[1]}.${imported.propertyName?.text ?? imported.name.text}`)
    }
  }
  return [...imports].sort()
}

export async function buildRenderer({ outdir = resolve(desktop, 'dist/renderer'), clean = true } = {}) {
  if (clean) await rm(outdir, { recursive: true, force: true })
  await mkdir(outdir, { recursive: true })
  const actions = new Map()
  const result = await build({
    absWorkingDir: repository,
    entryPoints: { app: resolve(renderer, 'index.tsx') },
    outdir,
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome130',
    jsx: 'automatic',
    minify: true,
    metafile: true,
    sourcemap: false,
    publicPath: '/mikka/',
    entryNames: 'assets/[name]-[hash]',
    chunkNames: 'assets/chunk-[hash]',
    assetNames: 'assets/[name]-[hash]',
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file' },
    tsconfig: resolve(desktop, 'tsconfig.renderer.json'),
    conditions: ['browser'],
    define: {
      'process.env.NODE_ENV': '"production"',
      'process.env.MIKKA_BASE_PATH': '"/mikka"',
      // A local UI is versioned by the RPC protocol, not a moving deployment id.
      'process.env.NEXT_PUBLIC_MIKKA_BUILD': '""',
      // Only this explicit public build configuration can enter the renderer.
      // Neither the shell environment nor backend credentials are spread here.
      'process.env': '{}',
    },
    plugins: [applicationBoundary(actions), bundledIconCatalogue(), bundledSyntaxCatalogue(), sharedStyles(), nativeOfflineView()],
    logLevel: 'info',
  })
  const outputs = Object.entries(result.metafile.outputs)
  const entry = outputs.find(([name, info]) => name.endsWith('.js') && info.entryPoint && resolve(repository, info.entryPoint) === resolve(renderer, 'index.tsx'))
  if (!entry?.[1].cssBundle) throw new Error('Desktop renderer entry or shared stylesheet was not emitted')
  const asset = filename => `/mikka/${slash(relative(outdir, resolve(repository, filename)))}`
  const template = await readFile(resolve(renderer, 'index.html'), 'utf8')
  await writeFile(resolve(outdir, 'index.html'), template.replace('__APP_SCRIPT__', asset(entry[0])).replace('__APP_STYLE__', asset(entry[1].cssBundle)))
  await cp(resolve(repository, 'public'), outdir, { recursive: true })
  const modules = Object.fromEntries([...actions].sort(([a], [b]) => a.localeCompare(b)))
  const inventory = {
    modules,
    exports: Object.values(modules).reduce((count, names) => count + names.length, 0),
    usedActions: await usedActionImports(Object.keys(result.metafile.inputs)),
    sourceActions: (await readdir(actionDirectory)).filter(name => name.endsWith('.ts')).length,
    inputs: Object.keys(result.metafile.inputs).filter(name => !name.includes('node_modules')).sort(),
  }
  // Build evidence contains filenames and exported identifiers, never runtime data.
  await writeFile(resolve(outdir, 'renderer-manifest.json'), `${JSON.stringify(inventory, null, 2)}\n`)
  await writeFile(resolve(desktop, 'dist/renderer-metafile.json'), `${JSON.stringify(result.metafile)}\n`)
  return inventory
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await buildRenderer()
