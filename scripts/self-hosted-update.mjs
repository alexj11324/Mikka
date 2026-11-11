#!/usr/bin/env node
/** Host-only upgrade controller. Never mount the Docker socket in the Mikka app.
 * No timer, registry polling, remote command execution, or destructive DB rollback. */
import { spawn, execFileSync } from 'node:child_process'
import { openSync, closeSync, unlinkSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync, statSync, realpathSync } from 'node:fs'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { assessUpgrade, assertPinnedImage, ensureRegularEnvFile, IMAGE_REPOSITORY, migrationsFingerprint, parseStableRelease, STABLE_TAG } from './self-hosted-update-policy.mjs'

const root = process.cwd()
const composeFile = process.env.MIKKA_UPDATE_COMPOSE_FILE || 'docker-compose.yml'
const stateDirectory = resolve(process.env.MIKKA_UPDATE_STATE_DIR || '.mikka-updates')
const environmentFile = resolve(root, '.env')
const hashProgram = [
  "const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');",
  "const files=[];const walk=p=>{for(const x of fs.readdirSync(p,{withFileTypes:true})){const f=path.join(p,x.name);if(x.isDirectory())walk(f);else if(x.isFile())files.push(f)}};",
  "walk('drizzle');const h=crypto.createHash('sha256');for(const f of files.sort()){h.update(path.relative('drizzle',f).replaceAll('\\\\','/'));h.update('\\0');h.update(fs.readFileSync(f));h.update('\\0')};process.stdout.write(h.digest('hex'));"
].join('')

function fail(code) { throw new Error(code) }
function docker(args, env = process.env, { maxBuffer = 8 * 1024 * 1024 } = {}) {
  try { return execFileSync('docker', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer }).trim() }
  catch { fail('SELF_HOSTED_UPDATE_DOCKER_FAILED') }
}
function compose(args, env = process.env) {
  return docker(['compose', '--project-directory', root, '-f', composeFile, ...args], env)
}
function runHook(name, phase = '') {
  const executable = process.env[name]
  if (!executable || !executable.startsWith('/') || realpathSync(executable) !== executable) fail('SELF_HOSTED_UPDATE_HOOK_REQUIRED')
  try { execFileSync(executable, phase ? [phase] : [], { cwd: root, env: process.env, stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000 }) }
  catch { fail('SELF_HOSTED_UPDATE_HOOK_FAILED') }
}
function imageInfo(image) {
  const info = JSON.parse(docker(['image', 'inspect', image]))[0]
  if (!info?.Config?.Labels) fail('SELF_HOSTED_UPDATE_IMAGE_LABEL_MISSING')
  return { revision: info.Config.Labels['org.opencontainers.image.revision'], digests: info.RepoDigests || [] }
}
function imageMigrations(image) {
  const result = docker(['run', '--rm', '--network', 'none', '--entrypoint', 'node', image, '-e', hashProgram])
  if (!/^[0-9a-f]{64}$/.test(result)) fail('SELF_HOSTED_UPDATE_MIGRATION_INVENTORY_FAILED')
  return result
}
function activeImage() {
  const containerId = compose(['ps', '-q', 'app'])
  if (!/^[0-9a-f]{12,64}$/.test(containerId)) fail('SELF_HOSTED_UPDATE_RUNNING_APP_REQUIRED')
  const container = JSON.parse(docker(['inspect', containerId]))[0]
  if (!/^sha256:[0-9a-f]{64}$/.test(container?.Image || '')) fail('SELF_HOSTED_UPDATE_RUNNING_IMAGE_INVALID')
  const info = imageInfo(container.Image)
  return { id: containerId, image: container.Image, revision: info.revision, migrations: imageMigrations(container.Image) }
}
function config() {
  if (!['docker-compose.yml', 'docker-compose.neon.yml'].includes(composeFile)) fail('SELF_HOSTED_UPDATE_COMPOSE_NOT_SUPPORTED')
  const conf = JSON.parse(compose(['config', '--format', 'json']))
  if (!conf?.services?.app || !conf.services.app.volumes?.length) fail('SELF_HOSTED_UPDATE_COMPOSE_UNSUPPORTED')
  return { localDatabase: !!conf.services.postgres }
}
async function githubRelease(tag) {
  if (!STABLE_TAG.test(tag)) fail('SELF_HOSTED_UPDATE_RELEASE_NOT_STABLE')
  const url = 'https://api.github.com/repos/alexj11324/Mikka/releases/tags/' + encodeURIComponent(tag)
  const response = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'mikka-self-hosted-updater' }, signal: AbortSignal.timeout(12_000) })
  if (!response.ok) fail('SELF_HOSTED_UPDATE_RELEASE_FETCH_FAILED')
  const json = await response.json()
  const release = parseStableRelease(json)
  if (release.tag !== tag) fail('SELF_HOSTED_UPDATE_RELEASE_TAG_MISMATCH')
  return release
}
function replaceImage(text, image) {
  const lines = text.split(/\r?\n/)
  const positions = lines.flatMap((line, i) => /^\s*(?:export\s+)?MIKKA_IMAGE\s*=/.test(line) ? [i] : [])
  if (positions.length > 1) fail('SELF_HOSTED_UPDATE_DUPLICATE_IMAGE_VAR')
  if (positions.length) lines[positions[0]] = 'MIKKA_IMAGE=' + image
  else lines.push('MIKKA_IMAGE=' + image)
  return lines.join('\n').replace(/\n*$/, '\n')
}
function saveAtomic(path, contents) {
  const temporary = path + '.' + randomUUID() + '.tmp'
  writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' })
  renameSync(temporary, path)
}
async function dumpLocalPostgres(destination) {
  const output = createWriteStream(destination, { mode: 0o600, flags: 'wx' })
  const process = spawn('docker', ['compose', '--project-directory', root, '-f', composeFile, 'exec', '-T', 'postgres', 'pg_dumpall', '-U', 'mikka'], {
    cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe']
  })
  let error = ''
  process.stderr.on('data', chunk => { error += chunk.toString().slice(0, 100) })
  const completed = new Promise((accept, reject) => {
    process.on('error', reject)
    process.on('close', code => code === 0 ? accept() : reject(new Error('SELF_HOSTED_UPDATE_DATABASE_BACKUP_FAILED')))
  })
  await Promise.all([pipeline(process.stdout, output), completed])
  if (statSync(destination).size < 256) fail('SELF_HOSTED_UPDATE_DATABASE_BACKUP_EMPTY')
}
function restoreOldApp(envText, oldImage) {
  saveAtomic(environmentFile, envText)
  compose(['up', '-d', '--no-deps', '--wait', '--wait-timeout', '240', 'app'], { ...process.env, MIKKA_IMAGE: oldImage })
  compose(['exec', '-T', 'app', 'node', 'scripts/self-hosted-health.mjs'], { ...process.env, MIKKA_IMAGE: oldImage })
}
function assertOption(value) { if (!value) fail('SELF_HOSTED_UPDATE_EXPLICIT_IDLE_ACK_REQUIRED') }
function executeRelease(tag, opts) {
  return githubRelease(tag).then(release => performUpgrade(release, opts))
}
async function performUpgrade(release, opts) {
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 })
  const lockPath = join(stateDirectory, 'upgrade.lock')
  let lock
  try { lock = openSync(lockPath, 'wx', 0o600) }
  catch { fail('SELF_HOSTED_UPDATE_ALREADY_RUNNING') }
  let drained = false
  try {
    ensureRegularEnvFile(environmentFile)
    if (opts.auto && (!process.env.MIKKA_UPDATE_IDLE_GUARD || !process.env.MIKKA_UPDATE_DRAIN_HOOK)) fail('SELF_HOSTED_UPDATE_DRAIN_REQUIRED')
    if (!opts.auto) assertOption(opts.ackIdle)
    const { localDatabase } = config()
    const original = activeImage()
    if (original.revision === release.revision) return { status: 'already-current', tag: release.tag }
    const backupHook = localDatabase || !!process.env.MIKKA_EXTERNAL_DB_BACKUP_HOOK
    const assessment = assessUpgrade(original, release, {
      unattended: opts.auto, allowMigrations: opts.allowMigrations,
      idleGuard: !!process.env.MIKKA_UPDATE_IDLE_GUARD, drainHook: !!process.env.MIKKA_UPDATE_DRAIN_HOOK,
      backupHook
    })
    if (!localDatabase && !backupHook) fail('SELF_HOSTED_UPDATE_EXTERNAL_BACKUP_REQUIRED')
    if (opts.auto && !backupHook) fail('SELF_HOSTED_UPDATE_EXTERNAL_BACKUP_REQUIRED')
    docker(['pull', release.image])
    const pulled = imageInfo(release.image)
    if (pulled.revision !== release.revision || imageMigrations(release.image) !== release.migrations) fail('SELF_HOSTED_UPDATE_RELEASE_IMAGE_MISMATCH')
    const digest = pulled.digests.find(x => x.startsWith(IMAGE_REPOSITORY + '@sha256:'))
    assertPinnedImage(digest)
    if (process.env.MIKKA_UPDATE_DRAIN_HOOK) {
      runHook('MIKKA_UPDATE_DRAIN_HOOK', 'enable')
      drained = true
    }
    if (process.env.MIKKA_UPDATE_IDLE_GUARD) runHook('MIKKA_UPDATE_IDLE_GUARD')
    const backupDirectory = join(stateDirectory, new Date().toISOString().replace(/[:.]/g, '-') + '-' + release.tag)
    mkdirSync(backupDirectory, { mode: 0o700 })
    const originalEnvironment = statSync(environmentFile, { throwIfNoEntry: false }) ? readFileSync(environmentFile, 'utf8') : ''
    saveAtomic(join(backupDirectory, 'env.original'), originalEnvironment)
    if (localDatabase) await dumpLocalPostgres(join(backupDirectory, 'postgres.sql'))
    else runHook('MIKKA_EXTERNAL_DB_BACKUP_HOOK', backupDirectory)
    // Closing traffic and proving no active task are operator-supplied gates.
    // Stop before copying app-data so the snapshot is not racing its writer.
    let stopped = false
    let activated = false
    try {
      compose(['stop', '-t', '60', 'app'])
      stopped = true
      mkdirSync(join(backupDirectory, 'app-data'), { mode: 0o700 })
      docker(['cp', original.id + ':/data/.', join(backupDirectory, 'app-data')])
      saveAtomic(environmentFile, replaceImage(originalEnvironment, digest))
      activated = true
      const deployment = { ...process.env, MIKKA_IMAGE: digest }
      compose(['up', '-d', '--no-deps', '--wait', '--wait-timeout', '240', 'app'], deployment)
      compose(['exec', '-T', '-e', 'MIKKA_EXPECTED_REVISION=' + release.revision, 'app', 'node', 'scripts/self-hosted-smoke.mjs'], deployment)
      saveAtomic(join(stateDirectory, 'last-success.json'), JSON.stringify({
        tag: release.tag, revision: release.revision, image: digest, migrated: assessment.migrationChanged,
        installedAt: new Date().toISOString()
      }) + '\n')
      return { status: 'updated', tag: release.tag, revision: release.revision, backup: backupDirectory }
    } catch {
      if (!activated || !assessment.migrationChanged) {
        try {
          restoreOldApp(originalEnvironment, original.image)
          fail('SELF_HOSTED_UPDATE_REVERTED_TO_PREVIOUS_IMAGE')
        } catch { fail('SELF_HOSTED_UPDATE_MANUAL_RECOVERY_REQUIRED') }
      }
      // New startup may have executed DDL. Never silently run old binaries
      // against a potentially advanced schema or restore a live database.
      fail('SELF_HOSTED_UPDATE_MIGRATION_RECOVERY_REQUIRED')
    } finally {
      if (stopped && !activated) {
        try { restoreOldApp(originalEnvironment, original.image) } catch { /* fail-closed recovery required */ }
      }
    }
  } finally {
    if (drained) {
      try { runHook('MIKKA_UPDATE_DRAIN_HOOK', 'disable') }
      catch { console.error('SELF_HOSTED_UPDATE_DRAIN_RELEASE_FAILED') }
    }
    closeSync(lock)
    unlinkSync(lockPath)
  }
}

async function main() {
  const [command, tag, ...flags] = process.argv.slice(2)
  if (!['check', 'apply'].includes(command) || !tag || !STABLE_TAG.test(tag)) fail('SELF_HOSTED_UPDATE_USAGE')
  const opts = { auto: flags.includes('--auto'), ackIdle: flags.includes('--ack-idle'), allowMigrations: flags.includes('--allow-migrations') }
  if (flags.some(x => !['--auto', '--ack-idle', '--allow-migrations'].includes(x)) || (opts.auto && (opts.ackIdle || opts.allowMigrations))) fail('SELF_HOSTED_UPDATE_USAGE')
  const release = await githubRelease(tag)
  if (command === 'check') return { status: 'available', tag: release.tag, revision: release.revision, image: release.image }
  return performUpgrade(release, opts)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await main())) }
  catch (error) {
    console.error(/^SELF_HOSTED_UPDATE_[A-Z0-9_]+$/.test(error?.message || '') ? error.message : 'SELF_HOSTED_UPDATE_FAILED')
    process.exitCode = 1
  }
}
export { replaceImage, performUpgrade, imageMigrations }
