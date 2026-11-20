import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIXTURE_LOGIN_PROXY_MARKER } from './proxy.mjs'

/** The same product graph ships for a fixture and a release. Auth helpers stay in the harness. */
export async function assertNoFixtureAuthInDirectories(directories) {
  let checked = 0
  async function scan(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory() && entry.name !== 'node_modules') await scan(path)
      else if (entry.isFile() && /\.(?:m?js|json)$/.test(entry.name)) {
        const text = await readFile(path, 'utf8'); checked++
        if (text.includes(FIXTURE_LOGIN_PROXY_MARKER) || text.includes('FIXTURE_PASSWORD_LOGIN_FAILED') || text.includes('scripts/fixtures/proxy.mjs'))
          throw new Error('FIXTURE_AUTH_ENTERED_PRODUCT_OUTPUT')
      }
    }
  }
  for (const directory of directories) await scan(directory)
  if (!checked) throw new Error('FIXTURE_PRODUCT_OUTPUT_MISSING')
  return checked
}
export function assertNoFixtureAuthInOutput(root) {
  return assertNoFixtureAuthInDirectories([join(root, '.output/server'), join(root, 'apps/frontend/dist/web')])
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const checked = await assertNoFixtureAuthInOutput(process.cwd())
  console.log(JSON.stringify({ fixtureAuthInProduct: false, checkedFiles: checked }))
}
