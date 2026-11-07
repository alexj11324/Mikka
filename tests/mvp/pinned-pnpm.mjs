import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** Verify an installed package manager; this prerequisite never installs one. */
export function resolvePinnedPnpm({
  packageManager = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).packageManager,
  env = process.env,
  execute = execFileSync,
} = {}) {
  const pinned = /^pnpm@(\d+\.\d+\.\d+)(?:\+sha(?:224|256|384|512)\.[a-f0-9]+)?$/.exec(packageManager)?.[1]
  if (!pinned) throw new Error('INVALID_PINNED_PNPM')
  const options = {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, maxBuffer: 64 * 1024,
    env: {
      ...Object.fromEntries(['PATH', 'HOME', 'COREPACK_HOME', 'XDG_CACHE_HOME']
        .filter(key => typeof env[key] === 'string').map(key => [key, env[key]])),
      NODE_OPTIONS: '',
      COREPACK_ENABLE_NETWORK: '0',
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      COREPACK_ENABLE_AUTO_PIN: '0',
      COREPACK_ENABLE_PROJECT_SPEC: '0',
      // pnpm 10 and 11 respectively: report the installed version instead of
      // downloading or switching to packageManager before handling --version.
      npm_config_manage_package_manager_versions: 'false',
      pnpm_config_pm_on_fail: 'ignore',
    },
  }
  // pnpm/action-setup installs pnpm directly; a Corepack cache is not required.
  const candidates = [{ file: 'pnpm', args: [] }, { file: 'corepack', args: [packageManager] }]
  const failures = []
  for (const candidate of candidates) {
    try {
      if (execute(candidate.file, [...candidate.args, '--version'], options).trim() === pinned)
        return { ...candidate, version: pinned }
      failures.push(new Error('PNPM_VERSION_MISMATCH'))
    } catch (error) { failures.push(error) }
  }
  throw new Error('MISSING_PINNED_PNPM', { cause: new AggregateError(failures, 'PNPM_CANDIDATES_FAILED') })
}
