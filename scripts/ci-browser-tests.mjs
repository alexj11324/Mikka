// Execute a trusted classifier's fixed spec list as argv, never as shell code.
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { BROWSER_SMOKE, BROWSER_SCOPED_SPECS } from './ci-docs-only.mjs'

export function browserArguments(tier, encodedSpecs) {
  const specs = JSON.parse(encodedSpecs)
  if (!Array.isArray(specs) || specs.some(spec => typeof spec !== 'string') || new Set(specs).size !== specs.length) throw new Error('Invalid browser spec list')
  const allowed = new Set([...BROWSER_SMOKE, ...BROWSER_SCOPED_SPECS])
  if (specs.some(spec => !allowed.has(spec))) throw new Error('Unrecognized browser spec')
  if (tier === 'full') {
    if (specs.length) throw new Error('Full regression cannot be narrowed')
  } else if (tier === 'smoke' || tier === 'targeted') {
    if (!BROWSER_SMOKE.every(spec => specs.includes(spec))) throw new Error('Critical browser flows cannot be omitted')
    if (tier === 'smoke' && specs.length !== BROWSER_SMOKE.length) throw new Error('Invalid smoke plan')
  } else throw new Error('Missing or invalid browser tier')
  return ['exec', 'playwright', 'test', ...specs.map(spec => `tests/e2e/${spec}`), '--grep-invert', '@performance']
}

export function main() {
  const args = browserArguments(process.env.BROWSER_TIER, process.env.BROWSER_SPECS)
  console.log(`Browser acceptance layer: ${process.env.BROWSER_TIER}; ${args.join(' ')}`)
  const result = spawnSync('pnpm', args, { stdio: 'inherit', env: process.env })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
