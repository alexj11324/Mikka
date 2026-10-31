import { createHash } from 'node:crypto'
import { appendFile, copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { releaseIdentity } from './ci-gate.mjs'

const MANIFEST = 'mikka-release-manifest.json'
const SHA = /^[a-f0-9]{40}$/
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = bytes => JSON.parse(String(bytes))

/** Keep build directories/debug configuration out of public desktop artifacts. */
export async function stageDesktop(source, target) {
  await mkdir(target)
  const files = []
  for (const name of (await readdir(source)).sort()) {
    if (!/^[A-Za-z0-9._-]+\.(dmg|zip|blockmap)$/.test(name) && name !== 'latest-mac.yml') continue
    const from = join(source, name)
    if (!(await lstat(from)).isFile()) throw Error('releaseDesktopArtifactInvalid')
    await copyFile(from, join(target, name)); files.push(name)
  }
  if (!files.includes('latest-mac.yml') || !files.some(name => name.endsWith('.zip')) || !files.some(name => name.endsWith('.dmg'))) throw Error('releaseDesktopArtifactMissing')
  await writeFile(join(target, 'SHA256SUMS.txt'), (await Promise.all(files.map(async name => `${hash(await readFile(join(target, name)))}  ${name}`))).join('\n') + '\n')
}

/** Pin the direct runtime dependencies that were actually installed from the frozen workspace lock. */
export async function pinRuntime(directory, sourceDirectory) {
  const file = join(directory, 'package.json'), manifest = json(await readFile(file))
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name)) throw Error('releaseDependencyNameInvalid')
    const installed = json(await readFile(join(sourceDirectory, 'node_modules', name, 'package.json')))
    if (installed.name !== name || !SEMVER.test(installed.version)) throw Error('releaseDependencyVersionUnavailable')
    manifest.dependencies[name] = installed.version
  }
  await writeFile(file, JSON.stringify(manifest, null, 2) + '\n')
}

export async function artifactInventory(directory) {
  const entries = []
  async function visit(path) {
    for (const name of (await readdir(path)).sort()) {
      const target = join(path, name), key = relative(directory, target).replaceAll('\\', '/')
      if (key === MANIFEST) continue
      const stat = await lstat(target)
      if (stat.isSymbolicLink()) throw Error('releaseArtifactSymlinkRejected')
      if (stat.isDirectory()) {
        if (name === 'node_modules' || name === '.git') throw Error('releaseArtifactDirectoryRejected')
        await visit(target)
      } else if (stat.isFile()) entries.push({ path: key, size: stat.size, sha256: hash(await readFile(target)) })
      else throw Error('releaseArtifactTypeRejected')
    }
  }
  await visit(resolve(directory))
  if (!entries.length) throw Error('releaseArtifactEmpty')
  return entries
}

export function validateBom(bom) {
  if (bom.bomFormat !== 'CycloneDX' || !Array.isArray(bom.components) || !bom.metadata?.component)
    throw Error('releaseSbomInvalid')
  if (bom.components.some(component => !component.name || !component.version)) throw Error('releaseSbomComponentInvalid')
}

export async function sealArtifact({ directory, sourceSha, identity, sourceLock, bomFile = 'sbom.cdx.json' }) {
  if (!SHA.test(sourceSha) || identity.sha !== sourceSha) throw Error('releaseSourceMismatch')
  if (!['github-actions-main', 'local-drill', 'unit-fixture'].includes(identity.kind)) throw Error('releaseBuildKindInvalid')
  const bom = json(await readFile(join(directory, bomFile)))
  validateBom(bom)
  const manifest = { version: 1, sourceSha, repository: identity.repository, buildRunId: identity.runId, buildKind: identity.kind,
    sourceLockSha256: hash(await readFile(sourceLock)), createdAt: new Date().toISOString(),
    sbom: bomFile, files: await artifactInventory(directory) }
  const bytes = JSON.stringify(manifest, null, 2) + '\n'
  await writeFile(join(directory, MANIFEST), bytes)
  return { manifest, sha256: hash(bytes) }
}

export async function verifyArtifact({ directory, sourceSha, sourceLock, expectedManifestSha256, buildRunId, buildKind = 'github-actions-main' }) {
  const bytes = await readFile(join(directory, MANIFEST))
  // The expected digest comes from a trusted job output, never from the downloaded artifact itself.
  if (!/^[a-f0-9]{64}$/.test(expectedManifestSha256 ?? '') || hash(bytes) !== expectedManifestSha256) throw Error('releaseManifestMismatch')
  const manifest = json(bytes)
  if (manifest.version !== 1 || !SHA.test(sourceSha) || manifest.sourceSha !== sourceSha ||
      manifest.repository !== 'alexj11324/Mikka' || manifest.buildRunId !== buildRunId || manifest.buildKind !== buildKind) throw Error('releaseSourceMismatch')
  if (manifest.sourceLockSha256 !== hash(await readFile(sourceLock))) throw Error('releaseSourceLockMismatch')
  if (typeof manifest.sbom !== 'string' || !/^[A-Za-z0-9._-]+$/.test(manifest.sbom)) throw Error('releaseSbomPathInvalid')
  if (JSON.stringify(manifest.files) !== JSON.stringify(await artifactInventory(directory))) throw Error('releaseArtifactMismatch')
  validateBom(json(await readFile(join(directory, manifest.sbom))))
  return { sourceSha: manifest.sourceSha, buildRunId: manifest.buildRunId, files: manifest.files.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, rawDirectory, destination] = process.argv.slice(2)
  if (!rawDirectory || !['pin-runtime', 'stage-desktop', 'seal', 'verify'].includes(command)) throw Error('releaseEvidenceCommandRequired')
  const directory = resolve(rawDirectory), root = fileURLToPath(new URL('../../', import.meta.url))
  if (command === 'stage-desktop') {
    if (!destination) throw Error('releaseDesktopTargetRequired')
    await stageDesktop(directory, resolve(destination))
  } else if (command === 'pin-runtime') await pinRuntime(directory, join(root, 'packages/daemon'))
  else {
    const identity = releaseIdentity(process.env)
    if (command === 'seal') {
      const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
      if (actual !== identity.sha) throw Error('releaseCheckoutMismatch')
      const changed = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean)
      for (const file of changed) {
        if (!['packages/daemon/package.json', 'apps/desktop/package.json'].includes(file)) throw Error('releaseCheckoutDirty')
        const original = json(execFileSync('git', ['show', `HEAD:${file}`], { cwd: root })), current = json(await readFile(join(root, file)))
        for (const value of [original, current]) { delete value.version; delete value.gitHead }
        if (JSON.stringify(original) !== JSON.stringify(current)) throw Error('releaseCheckoutDirty')
      }
      const { manifest, sha256 } = await sealArtifact({ directory, sourceSha: identity.sha, identity, sourceLock: join(root, 'pnpm-lock.yaml') })
      if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `manifest-sha256=${sha256}\n`)
      console.log(JSON.stringify({ sourceSha: manifest.sourceSha, files: manifest.files.length, buildRunId: manifest.buildRunId, manifestSha256: sha256 }))
    } else console.log(JSON.stringify(await verifyArtifact({ directory, sourceSha: identity.sha, sourceLock: join(root, 'pnpm-lock.yaml'),
      expectedManifestSha256: process.env.RELEASE_MANIFEST_SHA256, buildRunId: identity.runId, buildKind: identity.kind })))
  }
}
