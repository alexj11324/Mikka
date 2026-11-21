// Official builds resolve UI slots from a private checkout. No credentials or
// private source are accepted as command arguments or printed by this helper.
import { execFileSync } from 'node:child_process'
import { appendFile, lstat, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { resolve, join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PRODUCTION_VERSION_URL } from './web-deploy.mjs'

const SHA = /^[a-f0-9]{40}$/
export function overlaySha(value) {
  if (!SHA.test(value ?? '')) throw new Error('hostedUi:overlayShaRequired')
  return value
}

export async function recordOverlay(directory, { env = process.env } = {}) {
  const path = await realpath(directory)
  if (/[\r\n]/.test(path)) throw new Error('hostedUi:invalidDirectory')
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  if (await realpath(top) !== path) throw new Error('hostedUi:independentCheckoutRequired')
  const sha = overlaySha(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim())
  if (env.MIKKA_UI_OVERLAY_SHA && sha !== env.MIKKA_UI_OVERLAY_SHA) throw new Error('hostedUi:checkoutMismatch')
  if (env.GITHUB_ENV) await appendFile(env.GITHUB_ENV, `MIKKA_UI_OVERLAY_DIR=${path}\nMIKKA_UI_OVERLAY_SHA=${sha}\n${env.HOSTED_UI_READ_KEY ? 'HOSTED_UI_READ_KEY=\n' : ''}`)
  return { overlaySha: sha }
}

/** Pin the desktop overlay to the Web build already proven by await-web. */
export async function productionOverlay({ expectedOverlay, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(PRODUCTION_VERSION_URL, { cache: 'no-store', redirect: 'error',
    signal: AbortSignal.timeout(10_000), headers: { 'cache-control': 'no-cache' } })
  if (!response.ok) throw new Error('hostedUi:productionVersionUnavailable')
  const version = await response.json()
  overlaySha(version?.build)
  const sha = overlaySha(version?.overlaySha)
  if (expectedOverlay && sha !== overlaySha(expectedOverlay)) throw new Error('hostedUi:productionOverlayMismatch')
  return { overlaySha: sha, webBuild: version.build }
}

/** Inspect only distributable app-owned output, never a dependency cache. Fail
 * closed rather than printing a failing filename or source excerpt publicly. */
export async function assertNoSourceMaps(directory) {
  const root = await realpath(directory)
  let files = 0
  const visited = new Set()
  async function visit(path) {
    const canonical = await realpath(path)
    if (canonical !== root && !canonical.startsWith(root + sep)) throw new Error('hostedUi:outputOutsideRoot')
    if (visited.has(canonical)) return
    visited.add(canonical)
    const stat = await lstat(canonical)
    if (stat.isDirectory()) {
      for (const name of await readdir(canonical)) await visit(join(canonical, name))
    } else if (stat.isFile()) {
      files++
      if (/\.map$/i.test(canonical) || /\.(?:tsx?|jsx)$/.test(canonical) && !canonical.endsWith('.d.ts')) throw new Error('hostedUi:sourceInOutput')
      if (/\.(?:js|mjs|cjs|css|html|json)$/.test(canonical)) {
        const source = await readFile(canonical, 'utf8')
        if (/\/[/*][#@]\s*sourceMappingURL\s*=/.test(source) || /"sourcesContent"\s*:/.test(source)) throw new Error('hostedUi:sourceMapInOutput')
      }
    } else throw new Error('hostedUi:outputTypeInvalid')
  }
  await visit(root)
  if (!files) throw new Error('hostedUi:emptyOutput')
  return { sourceMaps: 0, files }
}

export async function desktopOverlayEvidence(directory, sha) {
  await writeFile(join(directory, 'mikka-ui-overlay.json'), JSON.stringify({ overlaySha: overlaySha(sha) }) + '\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, directory] = process.argv.slice(2)
    let result
    if (command === 'record') result = await recordOverlay(directory)
    else if (command === 'production') {
      result = await productionOverlay({ expectedOverlay: process.env.MIKKA_UI_OVERLAY_SHA || process.env.EXPECTED_UI_OVERLAY_SHA })
      if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `overlay-sha=${result.overlaySha}\n`)
    } else if (command === 'audit') result = await assertNoSourceMaps(directory)
    else if (command === 'desktop-evidence') {
      await desktopOverlayEvidence(directory, process.env.MIKKA_UI_OVERLAY_SHA)
      result = { overlaySha: overlaySha(process.env.MIKKA_UI_OVERLAY_SHA) }
    } else throw new Error('hostedUi:invalidCommand')
    console.log(JSON.stringify(result))
  } catch (error) {
    console.error(/^hostedUi:[A-Za-z]+$/.test(error?.message ?? '') ? error.message : 'hostedUi:operationFailed')
    process.exitCode = 1
  }
}
