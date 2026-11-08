import { spawnSync } from 'node:child_process'
import tasks from './tasks.json' with { type: 'json' }
const kind = process.argv[2]
if (!['core', 'integration'].includes(kind)) throw Error('unitKindRequired')
const selected = JSON.parse(process.env.CI_UNITS || 'null')
if (!Array.isArray(selected) || !selected.length) throw Error('unitSelectionRequired')
const all = Object.entries(tasks).filter(([, task]) => task.kind === kind).map(([key]) => `ci-${key}`)
const names = selected.includes('*') ? all : selected.filter(key => all.includes(key))
if (!names.length || selected.some(key => key !== '*' && !Object.hasOwn(tasks, key.replace(/^ci-/, '')))) throw Error('invalidUnitSelection')
const result = spawnSync('pnpm', ['exec', 'nx', 'run-many', '-t', names.map(n => n.slice(3)).join(','), '--projects', 'ci-tasks', '--parallel=2', '--outputStyle=stream', '--skip-nx-cache'], { stdio: 'inherit', env: { ...process.env, NX_CACHE_PROJECT_GRAPH: 'false', NX_DAEMON: 'false', NX_ISOLATE_PLUGINS: 'false', NX_NO_CLOUD: 'true' } })
process.exitCode = result.status === 0 && !result.signal && !result.error ? 0 : 1
