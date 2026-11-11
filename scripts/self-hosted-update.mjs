#!/usr/bin/env node
/** Host-only upgrade controller. Never mount the Docker socket in the Mikka app.
 * No timer, registry polling, remote command execution, or destructive DB rollback. */
import { execFileSync } from 'node:child_process'
import { openSync, closeSync, fsyncSync, unlinkSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync, statfsSync, lstatSync, realpathSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { assessUpgrade, assertPinnedImage, compareStableTags, ensureRegularEnvFile, IMAGE_REPOSITORY, parseStableRelease, STABLE_TAG } from './self-hosted-update-policy.mjs'

const root = process.cwd()
const composeFile = process.env.MIKKA_UPDATE_COMPOSE_FILE || 'docker-compose.yml'
const stateDirectory = resolve(process.env.MIKKA_UPDATE_STATE_DIR || '.mikka-updates')
const environmentFile = resolve(root, '.env')
const hashProgram = [
  "const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');",
  "const files=[];const walk=p=>{for(const x of fs.readdirSync(p,{withFileTypes:true})){const f=path.join(p,x.name);if(x.isDirectory())walk(f);else if(x.isFile())files.push(f)}};",
  "walk('drizzle');const h=crypto.createHash('sha256');for(const f of files.sort()){h.update(path.relative('drizzle',f).replaceAll('\\\\','/'));h.update('\\0');h.update(fs.readFileSync(f));h.update('\\0')};process.stdout.write(h.digest('hex'));"
].join('')

function fail(code, cause) { throw new Error(code, { cause }) }
function docker(args, env = process.env, { maxBuffer = 8 * 1024 * 1024 } = {}) {
  try { return execFileSync('docker', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer, timeout: 20 * 60_000 }).trim() }
  catch (cause) { fail('SELF_HOSTED_UPDATE_DOCKER_FAILED', cause) }
}
function compose(args, env = process.env) {
  return docker(['compose', '--project-directory', root, '-f', composeFile, ...args], env)
}
function runHook(name, phase = '') {
  const executable = process.env[name]
  if (!executable || !executable.startsWith('/') || realpathSync(executable) !== executable) fail('SELF_HOSTED_UPDATE_HOOK_REQUIRED')
  try { execFileSync(executable, phase ? [phase] : [], { cwd: root, env: process.env, stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000 }) }
  catch (cause) { fail('SELF_HOSTED_UPDATE_HOOK_FAILED', cause) }
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
  const pinned = info.digests.find(name => name.startsWith(IMAGE_REPOSITORY + '@sha256:'))
  return { id: containerId, image: pinned ? assertPinnedImage(pinned) : container.Image, revision: info.revision, migrations: imageMigrations(container.Image) }
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
  writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx', flush: true })
  renameSync(temporary, path)
}
// Retain only a completely restored archive. The verification database is
// created by this invocation on the bundled server and never serves traffic.
function dumpLocalPostgres(directory) {
  const archive = join(directory, 'postgres.dump')
  const staging = archive + '.partial'
  const verifyDatabase = 'mikka_verify_' + randomUUID().replaceAll('-', '')
  const postgres = ['compose', '--project-directory', root, '-f', composeFile, 'exec', '-T', 'postgres']
  const output = openSync(staging, 'wx', 0o600)
  try {
    try {
      execFileSync('docker', [...postgres, 'pg_dump', '-U', 'mikka', '-Fc', '-d', 'mikka'], {
        cwd: root, stdio: ['ignore', output, 'pipe']
      })
      fsyncSync(output)
    } finally { closeSync(output) }
    docker([...postgres, 'createdb', '-U', 'mikka', '-T', 'template0', verifyDatabase])
    try {
      const input = openSync(staging, 'r')
      try {
        execFileSync('docker', [...postgres, 'pg_restore', '-U', 'mikka', '--exit-on-error', '--single-transaction', '-d', verifyDatabase], {
          cwd: root, stdio: [input, 'ignore', 'pipe']
        })
      } finally { closeSync(input) }
    } finally {
      docker([...postgres, 'dropdb', '-U', 'mikka', verifyDatabase])
    }
    renameSync(staging, archive)
    return archive
  } catch (cause) {
    unlinkSync(staging)
    throw new Error('SELF_HOSTED_UPDATE_DATABASE_BACKUP_FAILED', { cause })
  }
}
function restoreOldApp(envText, oldImage) {
  saveAtomic(environmentFile, replaceImage(envText, oldImage))
  compose(['up', '-d', '--no-deps', '--wait', '--wait-timeout', '240', 'app'], { ...process.env, MIKKA_IMAGE: oldImage })
  compose(['exec', '-T', 'app', 'node', 'scripts/self-hosted-health.mjs'], { ...process.env, MIKKA_IMAGE: oldImage })
}
function assertOption(value) { if (!value) fail('SELF_HOSTED_UPDATE_EXPLICIT_IDLE_ACK_REQUIRED') }
function privateStateDirectory() {
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 })
  const state = lstatSync(stateDirectory)
  if (!state.isDirectory() || state.isSymbolicLink() || (state.mode & 0o077) !== 0) fail('SELF_HOSTED_UPDATE_STATE_PERMISSIONS_INVALID')
}

function optionalRecord(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) }
  catch (cause) {
    if (cause.code === 'ENOENT') return null
    fail('SELF_HOSTED_UPDATE_STATE_INVALID', cause)
  }
}

function verifyArtifact(release) {
  const digest = assertPinnedImage(release.image)
  docker(['pull', digest])
  const pulled = imageInfo(digest)
  if (!pulled.digests.includes(digest)) fail('SELF_HOSTED_UPDATE_RELEASE_DIGEST_MISMATCH')
  if (pulled.revision !== release.revision || imageMigrations(digest) !== release.migrations) fail('SELF_HOSTED_UPDATE_RELEASE_IMAGE_MISMATCH')
}

function verifyRunningRelease(release) {
  const deployed = { ...process.env, MIKKA_IMAGE: release.image }
  compose(['exec', '-T', '-e', 'MIKKA_EXPECTED_REVISION=' + release.revision, 'app', 'node', 'scripts/self-hosted-update-smoke.mjs'], deployed)
  if (process.env.MIKKA_UPDATE_VERIFY_HOOK) runHook('MIKKA_UPDATE_VERIFY_HOOK', release.tag)
}

function startRelease(release) {
  compose(['up', '-d', '--no-deps', '--wait', '--wait-timeout', '240', 'app'], { ...process.env, MIKKA_IMAGE: release.image })
  verifyRunningRelease(release)
}

// Run inside the operator's app network. A one-shot container also works if
// the previous activation stopped before the application became healthy.
function assertIdle(recovery = false) {
  const program = `const { Client } = require('pg');
    (async () => {
      const client = new Client({connectionString: process.env.MIKKA_DATABASE_URL || process.env.DATABASE_URL, connectionTimeoutMillis: 10000});
      await client.connect();
      try {
        const {rowCount} = await client.query("SELECT 1 FROM agent_runs WHERE status IN ('queued','preparing','running','paused','waiting_input','finishing') LIMIT 1");
        process.stdout.write(rowCount ? 'active' : 'idle');
      } finally { await client.end() }
    })().catch(() => { process.exitCode = 1 })`
  const args = recovery ? ['run', '--rm', '--no-deps', '-T', '--entrypoint', 'node', 'app'] : ['exec', '-T', 'app', 'node']
  const status = compose([...args, '-e', program])
  if (status === 'active') fail('SELF_HOSTED_UPDATE_ACTIVE_TASKS')
  if (status !== 'idle') fail('SELF_HOSTED_UPDATE_IDLE_UNKNOWN')
}

function recordSuccess(release, migrated) {
  saveAtomic(join(stateDirectory, 'last-success.json'), JSON.stringify({
    tag: release.tag, revision: release.revision, image: release.image, migrated, installedAt: new Date().toISOString()
  }) + '\n')
}

async function performUpgrade(release, opts) {
  privateStateDirectory()
  const available = statfsSync(stateDirectory)
  if (BigInt(available.bavail) * BigInt(available.bsize) < 512n * 1024n * 1024n) fail('SELF_HOSTED_UPDATE_DISK_SPACE_LOW')
  const lockPath = join(stateDirectory, 'upgrade.lock')
  let lock
  try { lock = openSync(lockPath, 'wx', 0o600) }
  catch (cause) { fail('SELF_HOSTED_UPDATE_ALREADY_RUNNING', cause) }
  let drained = false
  let recoveryRequired = false
  try {
    ensureRegularEnvFile(environmentFile)
    if (opts.auto && (!process.env.MIKKA_UPDATE_IDLE_GUARD || !process.env.MIKKA_UPDATE_DRAIN_HOOK)) fail('SELF_HOSTED_UPDATE_DRAIN_REQUIRED')
    if (!opts.auto) assertOption(opts.ackIdle)
    const { localDatabase } = config()
    const journal = join(stateDirectory, 'recovery.json')
    const pending = optionalRecord(journal)
    if (opts.recover) {
      if (!pending || !STABLE_TAG.test(pending.tag) || compareStableTags(release.tag, pending.tag) < 0) fail('SELF_HOSTED_UPDATE_FORWARD_TARGET_REQUIRED')
      if ((release.tag === pending.tag && release.image !== pending.image) ||
        (release.migrations !== pending.migrations && !opts.allowMigrations)) fail('SELF_HOSTED_UPDATE_FORWARD_TARGET_INCOMPATIBLE')
      recoveryRequired = true
      verifyArtifact(release)
      if (pending.managedDrain && !process.env.MIKKA_UPDATE_DRAIN_HOOK) fail('SELF_HOSTED_UPDATE_DRAIN_REQUIRED')
      if (process.env.MIKKA_UPDATE_DRAIN_HOOK) { runHook('MIKKA_UPDATE_DRAIN_HOOK', 'enable'); drained = true }
      if (process.env.MIKKA_UPDATE_IDLE_GUARD) runHook('MIKKA_UPDATE_IDLE_GUARD')
      assertIdle(true)
      if (release.migrations !== pending.migrations) {
        const directory = join(stateDirectory, 'forward-backup-' + randomUUID())
        mkdirSync(directory, { mode: 0o700 })
        if (localDatabase) dumpLocalPostgres(directory)
        else runHook('MIKKA_EXTERNAL_DB_BACKUP_HOOK', directory)
      }
      const next = { ...pending, tag: release.tag, image: release.image, migrations: release.migrations }
      saveAtomic(journal, JSON.stringify(next))
      saveAtomic(environmentFile, replaceImage(readFileSync(environmentFile, 'utf8'), release.image))
      startRelease(release)
      recordSuccess(release, true)
      unlinkSync(journal)
      recoveryRequired = false
      return { status: 'recovered-forward', tag: release.tag, revision: release.revision, image: release.image, backup: pending.backup }
    }
    if (pending) fail('SELF_HOSTED_UPDATE_MANUAL_RECOVERY_REQUIRED')
    const original = activeImage()
    const lastPath = join(stateDirectory, 'last-success.json')
    const last = optionalRecord(lastPath)
    if (opts.auto) {
      if (!last || !STABLE_TAG.test(last.tag || '') || last.revision !== original.revision || last.image !== original.image) fail('SELF_HOSTED_UPDATE_STABLE_BASELINE_REQUIRED')
      if (compareStableTags(release.tag, last.tag) <= 0) return { status: 'ignored-older-release', tag: release.tag }
    } else if (last && STABLE_TAG.test(last.tag || '') && compareStableTags(release.tag, last.tag) < 0) {
      fail('SELF_HOSTED_UPDATE_DOWNGRADE_REFUSED')
    }
    if (original.revision === release.revision) {
      if (original.image !== release.image) fail('SELF_HOSTED_UPDATE_RELEASE_DIGEST_MISMATCH')
      verifyArtifact(release)
      verifyRunningRelease(release)
      const envText = statSync(environmentFile, { throwIfNoEntry: false }) ? readFileSync(environmentFile, 'utf8') : ''
      saveAtomic(environmentFile, replaceImage(envText, release.image))
      recordSuccess(release, false)
      return { status: 'already-current', tag: release.tag, image: release.image }
    }
    const backupHook = localDatabase || !!process.env.MIKKA_EXTERNAL_DB_BACKUP_HOOK
    const assessment = assessUpgrade(original, release, {
      unattended: opts.auto, allowMigrations: opts.allowMigrations,
      idleGuard: !!process.env.MIKKA_UPDATE_IDLE_GUARD, drainHook: !!process.env.MIKKA_UPDATE_DRAIN_HOOK,
      backupHook
    })
    if (!localDatabase && !backupHook) fail('SELF_HOSTED_UPDATE_EXTERNAL_BACKUP_REQUIRED')
    verifyArtifact(release)
    const digest = release.image
    if (process.env.MIKKA_UPDATE_DRAIN_HOOK) {
      runHook('MIKKA_UPDATE_DRAIN_HOOK', 'enable')
      drained = true
    }
    if (process.env.MIKKA_UPDATE_IDLE_GUARD) runHook('MIKKA_UPDATE_IDLE_GUARD')
    assertIdle()
    const backupDirectory = join(stateDirectory, new Date().toISOString().replace(/[:.]/g, '-') + '-' + release.tag)
    mkdirSync(backupDirectory, { mode: 0o700 })
    const originalEnvironment = statSync(environmentFile, { throwIfNoEntry: false }) ? readFileSync(environmentFile, 'utf8') : ''
    saveAtomic(join(backupDirectory, 'env.original'), originalEnvironment)
    if (localDatabase) dumpLocalPostgres(backupDirectory)
    else runHook('MIKKA_EXTERNAL_DB_BACKUP_HOOK', backupDirectory)
    // Stop before copying app-data so the snapshot is not racing its writer.
    let activated = false
    try {
      compose(['stop', '-t', '60', 'app'])
      mkdirSync(join(backupDirectory, 'app-data'), { mode: 0o700 })
      docker(['cp', original.id + ':/data/.', join(backupDirectory, 'app-data')])
      saveAtomic(journal, JSON.stringify({ tag: release.tag, image: digest, migrations: release.migrations,
        backup: backupDirectory, previousImage: original.image, managedDrain: drained }))
      saveAtomic(environmentFile, replaceImage(originalEnvironment, digest))
      activated = true
      startRelease(release)
      recordSuccess(release, assessment.migrationChanged)
      unlinkSync(journal)
      return { status: 'updated', tag: release.tag, revision: release.revision, image: digest, backup: backupDirectory }
    } catch (cause) {
      if (!activated || !assessment.migrationChanged) {
        let restored = false
        try { restoreOldApp(originalEnvironment, original.image); restored = true }
        catch { /* Preserve backup for manual recovery. */ }
        if (restored) {
          if (lstatSync(journal, { throwIfNoEntry: false })) unlinkSync(journal)
          fail('SELF_HOSTED_UPDATE_REVERTED_TO_PREVIOUS_IMAGE', cause)
        }
        recoveryRequired = true
        fail('SELF_HOSTED_UPDATE_MANUAL_RECOVERY_REQUIRED')
      }
      // DDL may already have run. Keep traffic drained and preserve the
      // candidate plus the private backups for explicit forward recovery.
      recoveryRequired = true
      fail('SELF_HOSTED_UPDATE_MIGRATION_RECOVERY_REQUIRED', cause)
    }
  } finally {
    try {
      if (drained && !recoveryRequired) runHook('MIKKA_UPDATE_DRAIN_HOOK', 'disable')
      else if (drained) console.error('SELF_HOSTED_UPDATE_TRAFFIC_REMAINS_DRAINED')
    } finally {
      closeSync(lock)
      unlinkSync(lockPath)
    }
  }
}

async function main() {
  const [command, tag, ...flags] = process.argv.slice(2)
  if (command === 'backup' && !tag) {
    if (!config().localDatabase) fail('SELF_HOSTED_UPDATE_LOCAL_BACKUP_REQUIRED')
    privateStateDirectory()
    const directory = join(stateDirectory, 'backup-' + randomUUID())
    mkdirSync(directory, { mode: 0o700 })
    return { status: 'restore-verified', archive: dumpLocalPostgres(directory) }
  }
  if (!['check', 'apply', 'recover'].includes(command) || !tag || !STABLE_TAG.test(tag)) fail('SELF_HOSTED_UPDATE_USAGE')
  const opts = { recover: command === 'recover', auto: flags.includes('--auto'), ackIdle: flags.includes('--ack-idle'), allowMigrations: flags.includes('--allow-migrations') }
  if (flags.some(x => !['--auto', '--ack-idle', '--allow-migrations'].includes(x)) || (opts.auto && (opts.recover || opts.ackIdle || opts.allowMigrations))) fail('SELF_HOSTED_UPDATE_USAGE')
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
export { githubRelease, replaceImage, performUpgrade, imageMigrations, hashProgram }
