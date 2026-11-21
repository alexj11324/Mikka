// Use this entrypoint instead of gh pr ready so a local acceptance bound to
// the exact committed source is checked before the full remote CI begins.
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { main as preflight } from './local-preflight.mjs'

export function parseArgs(args) {
  let pr
  let base = 'origin/main'
  for (const arg of args) {
    if (arg.startsWith('--base=')) base = arg.slice(7)
    else if (arg.startsWith('--pr=')) {
      const n = arg.slice(5)
      if (!/^[1-9]\d*$/.test(n)) throw new Error('Invalid PR number')
      pr = n
    } else throw new Error(`Unknown option: ${arg}`)
  }
  return { pr, base }
}

export async function main(args = process.argv.slice(2), exec = spawnSync) {
  const { pr, base } = parseArgs(args)
  const verified = await preflight(['verify-ready', `--base=${base}`])
  if (verified !== 0) throw new Error('Local acceptance not verified')
  const command = ['pr', 'ready', ...(pr ? [pr] : [])]
  const result = exec('gh', command, { stdio: 'inherit', shell: false })
  if (result.error || result.signal || result.status !== 0) throw new Error('gh pr ready failed; no success assumed')
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
