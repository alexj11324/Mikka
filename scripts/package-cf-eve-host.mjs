import { cp, lstat, mkdir, readFile, readdir, readlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateHostBuild } from '../cloudflare/eve-runtime/runtime/config.mjs'

async function assertPortableLinks(root, directory = root) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name)
    if (item.isSymbolicLink()) {
      const link = await readlink(path)
      const target = relative(root, resolve(dirname(path), link))
      if (isAbsolute(link) || target === '..' || target.startsWith('../') || isAbsolute(target)) {
        throw new Error('CF_EVE_IMAGE_EXTERNAL_LINK_REFUSED')
      }
    } else if (item.isDirectory()) await assertPortableLinks(root, path)
  }
}

/** Package an already-built Node Eve artifact; build credentials are not inputs. */
export async function packageCloudflareEveHost({
  root = process.cwd(), sourceSha, uiSha, releaseId,
} = {}) {
  const source = join(root, '.output', 'eve')
  const build = JSON.parse(await readFile(join(source, 'mikka-eve-build.json'), 'utf8'))
  const host = { version: 1, sourceSha, uiSha, releaseId }
  validateHostBuild(build, host, {
    MIKKA_EVE_HOST: 'cloudflare', MIKKA_EVE_WORKFLOW_WORLD: 'postgres',
    MIKKA_BUILD_REVISION: sourceSha, MIKKA_UI_OVERLAY_SHA: uiSha, MIKKA_EVE_RELEASE_ID: releaseId,
  })
  if ((await readdir(source)).some(name => name === '.env' || name.startsWith('.env.'))) {
    throw new Error('CF_EVE_IMAGE_ENV_FILE_REFUSED')
  }
  try {
    await lstat(join(source, '.eve', '.workflow-data'))
    throw new Error('CF_EVE_IMAGE_LOCAL_STATE_REFUSED')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await assertPortableLinks(source)
  const output = join(root, '.output', 'cf-eve')
  await mkdir(output, { recursive: true })
  if ((await readdir(output)).length) throw new Error('CF_EVE_IMAGE_OUTPUT_NOT_EMPTY')
  await cp(source, join(output, 'eve'), { recursive: true, verbatimSymlinks: true })
  await mkdir(join(output, 'runtime'), { recursive: true })
  for (const file of ['config.mjs', 'start.mjs']) {
    await cp(join(root, 'cloudflare', 'eve-runtime', 'runtime', file), join(output, 'runtime', file))
  }
  await cp(join(root, 'scripts', 'eve-service.mjs'), join(output, 'runtime', 'eve-service.mjs'))
  await writeFile(join(output, 'eve-host.json'), JSON.stringify(host, null, 2) + '\n')
  return { output, host }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await packageCloudflareEveHost({
      sourceSha: process.env.MIKKA_BUILD_REVISION, uiSha: process.env.MIKKA_UI_OVERLAY_SHA,
      releaseId: process.env.MIKKA_DEPLOYMENT_ID,
    })
    console.log(JSON.stringify({ packaged: true, ...result.host }))
  } catch {
    console.error('CF_EVE_IMAGE_PACKAGE_FAILED')
    process.exitCode = 1
  }
}
