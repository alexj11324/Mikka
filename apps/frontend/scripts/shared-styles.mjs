import tailwind from '@tailwindcss/postcss'
import { transform } from 'lightningcss'
import { sharedCssTargets } from './css-targets.mjs'

/** Use the same Tailwind and build-only Lightning CSS pass the application
 * shipped with. Vite must not perform a second, different color conversion.
 *
 * The version is pinned so the emitted bytes stay put across installs. Tailwind
 * expands `@apply` before this pass, so the pinned version only sees plain CSS;
 * a Lightning CSS pass that ran first would parse a nested `@apply` differently
 * in 1.30 and 1.32 and drop the surrounding selector. See css-targets.mjs for
 * the targets. */
export function sharedStylePlugins(repository, { development = false } = {}) {
  return [tailwind({ base: repository, optimize: true }), {
    postcssPlugin: 'mikka-shared-lightning-css',
    async OnceExit(root, { result }) {
      const transformed = transform({
        filename: result.opts.from ?? 'mikka-shared.css', code: Buffer.from(root.toString()), minify: !development,
        targets: sharedCssTargets,
      })
      const { default: postcss } = await import('postcss')
      root.removeAll()
      root.append(postcss.parse(Buffer.from(transformed.code).toString(), { from: result.opts.from }).nodes)
    },
  }]
}
