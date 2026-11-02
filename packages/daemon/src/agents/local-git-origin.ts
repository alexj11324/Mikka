import { lstatSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { localTestAccountsMode } from '@mikka/protocol/local-test-mode'

const repository = 'https://github.com/mikka-e2e/core-loop.git'

/** The one disposable origin created by dev:local, never a person's git config. */
export function localGitOrigin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!localTestAccountsMode(env) || !env.MIKKA_DEV_GIT_ORIGIN) return undefined
  const path = resolve(env.MIKKA_DEV_GIT_ORIGIN)
  const temporary = realpathSync(tmpdir())
  if (basename(path) !== 'origin.git' || !/^mvp-[a-f0-9-]{36}$/.test(basename(dirname(path)))
    || !basename(dirname(dirname(path))).startsWith('mikka-mvp-origin-')
    || dirname(dirname(dirname(path))) !== temporary
    || !path.startsWith(`${temporary}${sep}`) || !lstatSync(path).isDirectory() || realpathSync(path) !== path) {
    throw new Error('Invalid local acceptance Git origin')
  }
  return path
}

export function localGitConfig(env: NodeJS.ProcessEnv = process.env): readonly (readonly [string, string])[] {
  const origin = localGitOrigin(env)
  return origin ? [[`url.${pathToFileURL(origin).href}.insteadOf`, repository], ['protocol.file.allow', 'always']] : []
}
