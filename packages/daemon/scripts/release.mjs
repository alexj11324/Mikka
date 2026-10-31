import { appendFile, readFile, realpath, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

export function releaseVersion(runNumber) {
  if (!/^[1-9]\d*$/.test(runNumber ?? '') || !Number.isSafeInteger(Number(runNumber) + 1)) throw new Error('Invalid GitHub run number')
  return `0.0.${Number(runNumber) + 1}`
}

export async function releasePlan({ packageName, version, sha, fetchRegistry = fetch }) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Invalid release commit')
  const registry = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`
  const read = async suffix => {
    const response = await fetchRegistry(`${registry}/${suffix}`, { signal: AbortSignal.timeout(10_000) })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`npm registry returned ${response.status}`)
    return response.json()
  }
  const existing = await read(version)
  if (existing) {
    if (existing.gitHead !== sha) throw new Error(`Published ${version} does not match release commit`)
    return { published: true, tag: '' }
  }
  const latest = await read('latest')
  // shortcut: automated releases use 0.0.N; choose a new version line before changing that scheme.
  if (latest && !/^0\.0\.(0|[1-9]\d*)$/.test(latest.version)) throw new Error('Unexpected npm latest version; review automatic version scheme')
  return { published: false, tag: latest && Number(latest.version.split('.')[2]) > Number(version.split('.')[2]) ? `build-${version}` : 'latest' }
}

export async function verifyRelease(options, wait = delay) {
  // npm can acknowledge publication minutes before its registry serves the version.
  for (let attempt = 0; attempt < 31; attempt++) {
    const plan = await releasePlan(options)
    if (plan.published) return plan
    if (attempt < 30) await wait(10_000)
  }
  throw new Error(`npm accepted publication but ${options.version} is still unavailable; registry verification is incomplete`)
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = releaseVersion(process.env.GITHUB_RUN_NUMBER)
  const options = { packageName: process.env.MIKKA_DAEMON_PACKAGE_NAME, version, sha: process.env.GITHUB_SHA }
  const plan = await (process.argv.includes('--verify') ? verifyRelease(options) : releasePlan(options))
  const manifestPath = new URL('../package.json', import.meta.url)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.version = version
  manifest.gitHead = process.env.GITHUB_SHA
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\npublished=${plan.published}\ntag=${plan.tag}\n`)
  console.log(`${version}: ${plan.published ? 'already published from this commit' : `publish with tag ${plan.tag}`}`)
}
