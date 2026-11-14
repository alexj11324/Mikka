import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import tasks from './tasks.json' with { type: 'json' }

// Nx defaults FORCE_COLOR to true in children. Keep Actions' non-TTY semantics:
// native-process fixtures and machine-readable CLI output must remain plain.
export const unitEnvironment = env => ({ ...env, FORCE_COLOR: '0', NX_CACHE_PROJECT_GRAPH: 'false', NX_DAEMON: 'false', NX_ISOLATE_PLUGINS: 'false', NX_NO_CLOUD: 'true' })
export function main(kind, env = process.env, run = spawnSync) {
  if (!['core', 'integration'].includes(kind)) throw Error('unitKindRequired')
  const input = JSON.parse(env.CI_UNITS || 'null')
  if (!Array.isArray(input) || !input.length) throw Error('unitSelectionRequired')
  // A PR or main push can still receive the older trusted selector's standalone
  // docs classifier target. Its tests now run inside the mandatory UI policy suite.
  const selected = [...new Set(input.map(key => key === 'ci-core-6' ? 'ci-core-7' : key))]
  const all = Object.entries(tasks).filter(([, task]) => task.kind === kind).map(([key]) => `ci-${key}`)
  const names = selected.includes('*') ? all : selected.filter(key => all.includes(key))
  if (!names.length || selected.some(key => key !== '*' && !Object.hasOwn(tasks, key.replace(/^ci-/, '')))) throw Error('invalidUnitSelection')
  const result = run('pnpm', ['exec', 'nx', 'run-many', '-t', names.map(n => n.slice(3)).join(','), '--projects', 'ci-tasks', '--parallel=2', '--outputStyle=stream', '--skip-nx-cache'], { stdio: 'inherit', env: unitEnvironment(env) })
  return result.status === 0 && !result.signal && !result.error ? 0 : 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main(process.argv[2])
