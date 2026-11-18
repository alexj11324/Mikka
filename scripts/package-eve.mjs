import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package the separately built Eve Node output beside the app and copy its
 * runtime resources. Both outputs must have come from the same revision. */
export async function packageEve({ root = process.cwd(), preset = process.env.NITRO_PRESET || 'node-server' } = {}) {
  if (preset !== 'node-server') throw new Error('EVE_BUILD_PRESET_INVALID')
  const source = join(root, 'apps/eve/.output')
  const output = join(root, '.output')
  const agent = JSON.parse(await readFile(join(source, 'mikka-eve-build.json'), 'utf8'))
  const appPath = join(output, 'mikka-build.json')
  const app = JSON.parse(await readFile(appPath, 'utf8'))
  if (agent.version !== 1 || agent.eve !== '1.0.0-rc.9' || agent.revision !== app.revision || agent.preset !== preset) throw new Error('EVE_APP_BUILD_MISMATCH')
  await cp(source, join(output, 'eve'), { recursive: true })
  for (const resource of app.resources) {
    const destination = join(output, 'eve', resource.path)
    await mkdir(dirname(destination), { recursive: true })
    await cp(join(output, resource.path), destination)
  }
  app.eve = agent
  await writeFile(appPath, `${JSON.stringify(app, null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await packageEve()
