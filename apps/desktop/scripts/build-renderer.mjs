import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export { actionExports, actionSignatures, actionReferences, applicationBoundary, usedActionImports, nativeOfflineView } from './renderer-transforms.mjs'

/** The installed renderer and browser use the same Vite module graph. */
export async function buildRenderer(options = {}) {
  const { buildFrontend } = await import('../../frontend/scripts/build.mjs')
  return buildFrontend({ ...options, target: 'desktop', outdir: options.outdir ?? fileURLToPath(new URL('../dist/renderer', import.meta.url)) })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await buildRenderer()
