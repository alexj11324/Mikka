import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectMacPackage, savePackageVerification } from './verify-mac-package.mjs'

export function devPackageEnvironment(source) {
  // A review artifact must never inherit the release build's production default
  // or its signing credentials. Explicit ad-hoc signing needs no Apple account,
  // Developer ID, certificate import, Keychain ACL change or notarization.
  const raw = source.MIKKA_DESKTOP_APP_URL
  if (!raw) throw new Error('MIKKA_DESKTOP_APP_URL is required for a Mikka Dev test package')
  const url = new URL(raw)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || !['http:', 'https:'].includes(url.protocol) || (!local && url.protocol !== 'https:')) {
    throw new Error('The test backend must be loopback HTTP(S) or credential-free HTTPS')
  }
  if (url.hostname === 'app.aspectlylabs.com' || url.hostname === 'mikka.vercel.app') {
    throw new Error('Mikka Dev acceptance packages cannot connect to production')
  }
  const env = Object.fromEntries(Object.entries(source).filter(([name]) => !/^(?:(?:WIN_)?CSC_|APPLE_)/.test(name)))
  return { ...env, MIKKA_DESKTOP_FLAVOR: 'dev', CSC_IDENTITY_AUTO_DISCOVERY: 'false', CSC_FOR_PULL_REQUEST: 'true' }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args[0] && args[0] !== '--acceptance')) throw new Error('DEV_PACKAGE_ARGUMENTS')
  const variant = args[0] ? 'acceptance' : 'dev'
  const cwd = fileURLToPath(new URL('..', import.meta.url))
  const env = devPackageEnvironment(process.env)
  const buildArgs = ['node_modules/electron-builder/cli.js', '--config', `electron-builder.${variant}.yml`, '--mac', '--arm64', '--publish', 'never', ...(variant === 'acceptance' ? ['--dir'] : [])]
  const renderer = ['scripts/build.mjs']
  if (variant === 'acceptance' && !env.MIKKA_UI_OVERLAY_DIR && !env.MIKKA_UI_OVERLAY_SHA) renderer.push('--public-test-fixture')
  for (const command of [renderer, buildArgs]) {
    const result = spawnSync(process.execPath, command, { cwd, env, stdio: 'inherit' })
    if (result.error) throw new Error('Mikka Dev packaging could not start', { cause: result.error })
    if (result.status !== 0) process.exit(result.status ?? 1)
  }
  const output = join(cwd, `release-${variant}`)
  const report = await inspectMacPackage(join(output, 'mac-arm64', 'Mikka Dev.app'), variant)
  await savePackageVerification(join(output, 'mac-package-verification.json'), report)
  console.log(JSON.stringify(report))
  if (!report.passed) process.exitCode = 1
}
