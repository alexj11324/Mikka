import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, copyPublicAssets, createNitro, prepare } from 'nitro/builder'
import { finalizeBuild } from './finalize-build.mjs'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const preset = process.env.NITRO_PRESET || (process.env.VERCEL ? 'vercel' : 'node-server')
if (!['node-server', 'vercel'].includes(preset)) throw new Error('API_BUILD_PRESET_UNSUPPORTED')
const revision = process.env.VERCEL_GIT_COMMIT_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('API_BUILD_SHA_REQUIRED')
execFileSync(process.execPath, ['apps/api/scripts/generate-routes.mjs'], { cwd: root, stdio: 'inherit' })
const html = await readFile(join(root, 'apps/frontend/dist/web/index.html'), 'utf8')
if (!/<html\b/.test(html) || !html.includes('/mikka/assets/')) throw new Error('API_FRONTEND_OUTPUT_INVALID')
await mkdir(join(root, 'apps/api/generated'), { recursive: true })
await writeFile(join(root, 'apps/api/generated/spa.ts'), `// Generated from the same Vite build that supplies public assets.\nexport const spaHtml = ${JSON.stringify(html)}\n`)
const nitro = await createNitro({ rootDir: root, preset })
try {
  if (preset === 'node-server') {
    // One compilation graph supplies both the standard listener and the
    // explicitly non-listening Docker adapter; do not build another app copy.
    nitro.options.rolldownConfig = {
      ...nitro.options.rolldownConfig,
      input: { index: nitro.options.entry, 'docker-entry': join(root, 'apps/api/runtime/docker-entry.ts') },
      output: { entryFileNames: '[name].mjs' },
    }
  }
  await prepare(nitro)
  await copyPublicAssets(nitro)
  await build(nitro)
  const result = await finalizeBuild({ root, output: nitro.options.output.dir, preset, revision })
  console.log(JSON.stringify({ status: 'built', revision, preset, functions: result.functions.length, resources: result.resources.length }))
} finally { await nitro.close() }
