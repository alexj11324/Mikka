import { cp, lstat, mkdir, readdir, readlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

async function assertPortableLinks(root, directory = root) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.name === '.env' || item.name.startsWith('.env.')) throw new Error('CF_EVE_IMAGE_ENV_FILE_REFUSED')
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
  root = process.cwd(), sourceSha, uiSha, releaseId, uiSource = 'official',
} = {}) {
  const source = join(root, '.output', 'eve')
  if (!['official', 'public-server'].includes(uiSource) || (uiSource === 'public-server' && uiSha !== sourceSha)) {
    throw new Error('CF_EVE_UI_SOURCE_MISMATCH')
  }
  const host = { version: 1, sourceSha, uiSha, releaseId, uiSource }
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
  await writeFile(join(output, 'eve-host.json'), JSON.stringify(host, null, 2) + '\n')
  return { output, host }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const sourceSha = process.env.MIKKA_BUILD_REVISION
    const overlay = process.env.MIKKA_UI_OVERLAY_DIR
    const overlaySha = process.env.MIKKA_UI_OVERLAY_SHA
    if (Boolean(overlay) !== Boolean(overlaySha)) throw new Error('CF_EVE_UI_SOURCE_MISMATCH')
    const result = await packageCloudflareEveHost({
      sourceSha, uiSha: overlay ? overlaySha : sourceSha, uiSource: overlay ? 'official' : 'public-server',
      releaseId: process.env.MIKKA_DEPLOYMENT_ID,
    })
    console.log(JSON.stringify({ packaged: true, ...result.host }))
  } catch {
    console.error('CF_EVE_IMAGE_PACKAGE_FAILED')
    process.exitCode = 1
  }
}
