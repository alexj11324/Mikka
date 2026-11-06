import tailwind from '@tailwindcss/postcss'
import { loadBindings } from 'next/dist/build/swc/index.js'
import webBrowserTargets from 'next/dist/shared/lib/modern-browserslist-target.js'
import { getTargets } from 'next/dist/build/webpack/loaders/lightningcss-loader/src/utils.js'

/** Use the same Tailwind and Next build-only Lightning CSS pass as the
 * existing page. Vite must not perform a second, different color conversion. */
export function sharedStylePlugins(repository, { development = false } = {}) {
  return [tailwind({ base: repository, optimize: true }), {
    postcssPlugin: 'mikka-shared-lightning-css',
    async OnceExit(root, { result }) {
      const { css: { lightning } } = await loadBindings()
      const transformed = lightning.transform({
        filename: result.opts.from ?? 'mikka-shared.css', code: Buffer.from(root.toString()), minify: !development,
        targets: getTargets({ key: 'mikka-desktop-shared-css', targets: webBrowserTargets }),
      })
      const { default: postcss } = await import('postcss')
      root.removeAll()
      root.append(postcss.parse(Buffer.from(transformed.code).toString(), { from: result.opts.from }).nodes)
    },
  }]
}
