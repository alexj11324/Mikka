import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { baseSecurityHeaders } from './runtime/http-policy.mjs'

export async function publicAssetConfiguration(root) {
  const directory = join(root, 'apps/frontend/dist/web')
  const routeRules = { '/mikka/assets/**': { headers: { ...baseSecurityHeaders, 'cache-control': 'public, max-age=31536000, immutable' } } }
  async function visit(path, prefix = '') {
    let entries
    try { entries = await readdir(path, { withFileTypes: true }) }
    catch (error) { if (error.code === 'ENOENT' && path === directory) return; throw error }
    for (const entry of entries) {
      if (entry.name === '.vite' || entry.name === 'index.html') continue
      const relative = `${prefix}${entry.name}`
      if (entry.isDirectory()) await visit(join(path, entry.name), `${relative}/`)
      else if (entry.isFile() && !relative.startsWith('assets/')) routeRules[`/mikka/${relative}`] = { headers: { ...baseSecurityHeaders, 'cache-control': 'public, max-age=0, must-revalidate' } }
      else if (!entry.isFile()) throw new Error('API_PUBLIC_ASSET_TYPE_INVALID')
    }
  }
  await visit(directory)
  return {
    publicAssets: [
      // Nitro automatically adds root/public unless this exact directory is
      // declared. Vite already copied it into the base-path output below.
      { dir: join(root, 'public'), baseURL: '/mikka', ignore: ['**'], fallthrough: true },
      { dir: directory, baseURL: '/mikka', ignore: ['**/index.html', '**/.vite/**'], fallthrough: true, maxAge: 0 },
    ],
    routeRules,
  }
}
