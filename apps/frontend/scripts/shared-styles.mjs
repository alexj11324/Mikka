import tailwind from '@tailwindcss/postcss'
import { transform } from 'lightningcss'
import { sharedCssTargets } from './css-targets.mjs'

/** Use the same Tailwind and build-only Lightning CSS pass the application
 * shipped with. Vite must not perform a second, different color conversion.
 *
 * Lightning CSS 1.33.0 is pinned deliberately: 1.30 and 1.32 parse a nested
 * `@apply` differently and drop the surrounding selector, which changes
 * meaning rather than only formatting. See css-targets.mjs for the targets. */
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
