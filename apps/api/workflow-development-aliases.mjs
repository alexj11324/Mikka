import { createHash } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { build } from 'esbuild'
import { apiAliases } from './compat-aliases.mjs'
import { nodeRuntimePackages } from './build-contract.mjs'

/**
 * Workflow's dev LocalBuilder is loaded directly by Node, outside Nitro's
 * alias-aware bundle. Complete that same API compilation contract before its
 * lazy handler imports steps.mjs. Packages stay external, including pg, OTel
 * and the Workflow SDK's generated runtime imports; their singletons must not
 * be copied into the step bundle.
 */
export function developmentWorkflowAliases({ buildDir, replace = {} }) {
  const filename = join(buildDir, 'workflow/steps.mjs')
  let completedHash
  let pending = Promise.resolve()
  const compile = async () => {
    const source = await readFile(filename, 'utf8')
    const digest = value => createHash('sha256').update(value).digest('hex')
    if (digest(source) === completedHash) return
    const result = await build({
      stdin: { contents: source, resolveDir: dirname(filename), sourcefile: filename, loader: 'js' },
      outfile: filename, write: false, bundle: true, format: 'esm', platform: 'node', target: 'node24',
      packages: 'external', external: [...nodeRuntimePackages, apiAliases['mikka-real-react']],
      keepNames: true, treeShaking: false, sourcemap: false, logLevel: 'silent',
      define: Object.fromEntries(Object.entries(replace).filter(([key, value]) => /^process\.env\.[A-Z0-9_]+$/.test(key) && typeof value === 'string')),
      plugins: [{ name: 'mikka-workflow-api-aliases', setup(builder) {
        // Exact framework aliases must not rewrite unrelated subpaths such as
        // react/jsx-runtime. Only the application's @/ prefix is a prefix map.
        builder.onResolve({ filter: /^(?:@\/|next(?:\/|$)|next-intl\/|react$|mikka-real-react$|server-only$)/ }, async args => {
          const target = apiAliases[args.path] ?? (args.path.startsWith('@/') ? join(apiAliases['@'], args.path.slice(2)) : undefined)
          if (!target) return
          if (args.path === 'mikka-real-react') return { path: target, external: true }
          return builder.resolve(target, { importer: args.importer, resolveDir: args.resolveDir, kind: args.kind })
        })
      } }],
    })
    const output = result.outputFiles[0].contents
    // A concurrent request sees either complete artifact, never a partial write.
    const temporary = `${filename}.api-aliases`
    await writeFile(temporary, output)
    await rename(temporary, filename)
    completedHash = digest(output)
  }
  return () => {
    const next = pending.then(compile)
    pending = next.catch(() => {})
    return next
  }
}

/** Register after workflow/nitro so both initial and HMR builds finish first. */
export function workflowDevelopmentAliases(nitro) {
  if (!nitro.options.dev) return
  const compile = developmentWorkflowAliases(nitro.options)
  nitro.hooks.hook('build:before', compile)
  nitro.hooks.hook('dev:reload', compile)
}
