// electron-builder afterSign hook (electron-builder.yml): notarize the signed
// Mikka.app and staple its ticket before the dmg and zip are built from it.
//
// electron-builder's own `mac.notarize` stapled right after Apple accepted the
// app and gave up after three retries a few seconds apart. Three releases in a
// row (2026-11-02) failed there with stapler error 68 / NSURLErrorDomain -1005
// while fetching the new ticket from api.apple-cloudkit.com. Here the staple
// waits and retries for about five minutes. Nothing is skipped: the signature
// is verified first, notarization must be Accepted, the stapled app must pass
// `stapler validate`, and on CI missing credentials fail the build. A failed
// tool reports only its exit code and last stderr line, never its arguments.

import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Seconds to wait before each staple retry: six tries after the first, about five minutes. */
export const STAPLE_RETRY_DELAYS = [15, 30, 45, 60, 75, 90]

/**
 * notarytool credentials from the same variables electron-builder reads: an
 * Apple ID with an app-specific password, an App Store Connect API key, or a
 * keychain profile. Null when none is set (an unsigned local build).
 */
export function notaryAuth(env) {
  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID, APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER, APPLE_KEYCHAIN, APPLE_KEYCHAIN_PROFILE } = env
  if (APPLE_ID || APPLE_APP_SPECIFIC_PASSWORD) {
    if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) throw new Error('APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID need to be set together')
    return ['--apple-id', APPLE_ID, '--password', APPLE_APP_SPECIFIC_PASSWORD, '--team-id', APPLE_TEAM_ID]
  }
  if (APPLE_API_KEY || APPLE_API_KEY_ID || APPLE_API_ISSUER) {
    if (!APPLE_API_KEY || !APPLE_API_KEY_ID || !APPLE_API_ISSUER) throw new Error('APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER need to be set together')
    return ['--key', APPLE_API_KEY, '--key-id', APPLE_API_KEY_ID, '--issuer', APPLE_API_ISSUER]
  }
  if (APPLE_KEYCHAIN_PROFILE) return ['--keychain-profile', APPLE_KEYCHAIN_PROFILE, ...(APPLE_KEYCHAIN ? ['--keychain', APPLE_KEYCHAIN] : [])]
  return null
}

/**
 * The credentials, or null for a local build without any. On CI (CI or
 * GITHUB_ACTIONS set) a missing credential fails the build instead of
 * shipping an app that is signed but not notarized.
 */
export function requireNotaryAuth(env) {
  const auth = notaryAuth(env)
  if (!auth && (env.CI || env.GITHUB_ACTIONS)) throw new Error('Notarization credentials are missing on CI; a release must be notarized')
  return auth
}

/** The values of `--password`, `--key` and friends, which must never reach a log. */
export function secretValues(auth) {
  const values = []
  for (let index = 0; index < (auth?.length ?? 0); index += 1) {
    if (['--password', '--key', '--key-id', '--issuer', '--apple-id'].includes(auth[index]) && auth[index + 1]) values.push(auth[index + 1])
  }
  return values
}

/**
 * Runs a tool and, when it fails, throws only its exit code and the last line
 * of its stderr, with any credential value masked. execFile's own error
 * message carries the whole command line, credentials included.
 */
export async function runQuietly(exec, label, file, args, secrets = [], options = {}) {
  try {
    return await exec(file, args, options)
  } catch (error) {
    const lastLine = String(error?.stderr ?? '').trim().split('\n').at(-1) ?? ''
    const masked = secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join('***'), lastLine)
    throw new Error(`${label} failed (exit ${error?.code ?? 'unknown'})${masked ? `: ${masked}` : ''}`)
  }
}

/** Staples, retrying with STAPLE_RETRY_DELAYS; throws the last error once they run out. */
export async function stapleWithRetry(staple, { delays = STAPLE_RETRY_DELAYS, sleep = seconds => new Promise(resolve => setTimeout(resolve, seconds * 1000)), log = console.log } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await staple()
      return attempt + 1
    } catch (error) {
      if (attempt >= delays.length) throw error
      log(`staple attempt ${attempt + 1} failed (${error?.message ?? 'unknown error'}); retrying in ${delays[attempt]}s`)
      await sleep(delays[attempt])
    }
  }
}

export default async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const auth = requireNotaryAuth(process.env)
  if (!auth) {
    console.warn('No notarization credentials; this local build is signed but not notarized')
    return
  }
  const secrets = secretValues(auth)
  const quiet = (label, file, args, options) => runQuietly(run, label, file, args, secrets, options)
  await quiet('codesign --verify', 'codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
  const dir = await mkdtemp(join(tmpdir(), 'mikka-notarize-'))
  try {
    const zip = join(dir, 'Mikka.zip')
    await quiet('ditto', 'ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zip])
    const { stdout } = await quiet('notarytool submit', 'xcrun', ['notarytool', 'submit', zip, ...auth, '--wait', '--output-format', 'json'], { maxBuffer: 16 * 1024 * 1024 })
    const result = JSON.parse(stdout)
    if (result.status !== 'Accepted') {
      const details = await quiet('notarytool log', 'xcrun', ['notarytool', 'log', result.id, ...auth]).then(({ stdout: log }) => log, () => '')
      throw new Error(`Notarization ${result.status} (${result.id})\n${details}`)
    }
    console.log(`Notarization accepted (${result.id})`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  const attempts = await stapleWithRetry(() => quiet('stapler staple', 'xcrun', ['stapler', 'staple', appPath]))
  await quiet('stapler validate', 'xcrun', ['stapler', 'validate', appPath])
  console.log(`Stapled and validated after ${attempts} attempt(s)`)
}
