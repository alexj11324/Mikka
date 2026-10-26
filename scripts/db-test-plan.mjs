// R0: explicit DB coverage contracts. Pending recipes are failures, never exclusions.
import { createHash } from 'node:crypto'
const sorted = values => [...values].sort()
const equalSet = (a, b) => a.length === new Set(a).size && b.length === new Set(b).size && JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))
export const PHASES = ['prebuild', 'postbuild', 'external']
export function databaseFiles(files) {
  return Object.entries(files).filter(([file, source]) => /\.(test|spec)\.(ts|mjs|js)$/.test(file)
    && !['tests/migrate-empty-db.test.mjs', 'scripts/run-db-tests.test.mjs'].includes(file) && !file.startsWith('tests/e2e/')
    && (/(?:\.db\.test\.|-db\.test\.)/.test(file) || /(?:from\s*['"]pg['"]|import\(['"]pg['"]\)|REQUIRE_DB|CONVERSATION_READS_REQUIRE_DB)/.test(source))).map(([file]) => file)
}
export function coveragePlan(files, scripts, config, { required = [], selfManaged = [], expected = config.expected } = {}) {
  if (config.version !== 1 || !Array.isArray(config.recipes) || !config.recipes.length) throw Error('Missing R0 recipes')
  const ids = config.recipes.map(r => r.id)
  if (!equalSet(ids, config.expected ?? []) || !equalSet(ids, expected ?? [])) throw Error('Complete expected recipe set must match exactly')
  const exempt = new Set()
  for (const entry of selfManaged) {
    if (!Object.hasOwn(files, entry.file)) continue
    if (!entry.reason || !files[entry.runner]?.includes(entry.file)) throw Error(`Invalid existing self-managed contract: ${entry.file}`)
    exempt.add(entry.file)
  }
  const coverage = new Map(), profiles = config.profiles ?? {}, contractErrors = []
  for (const r of config.recipes) {
    if (!/^[a-z0-9][a-z0-9:-]*$/.test(r.id) || !PHASES.includes(r.phase) || !['ready', 'pending'].includes(r.status)) throw Error(`Invalid recipe ${r.id}`)
    if (r.status === 'pending' && !r.pendingReason) throw Error(`Pending recipe needs reason: ${r.id}`)
    if (!Array.isArray(r.command) || !r.command.length || r.command.some(x => typeof x !== 'string' || !x)) throw Error(`Missing command: ${r.id}`)
    const p = profiles[r.profile]
    if (!p || !Array.isArray(p.targets) || !p.bindings || !p.env || (!p.targets.length && !p.provisioner)) throw Error(`Missing target profile: ${r.id}`)
    if (p.provisioner && (!files[p.provisioner] || p.provisioner !== r.runner || !p.provisionedTarget?.database || p.provisionedTarget.host !== '127.0.0.1')) throw Error(`Missing provisioning contract: ${r.id}`)
    for (const target of p.targets) if (!target.key || (!target.database && !target.suffix) || target.host !== '127.0.0.1' || !/^[0-9]+$/.test(target.port ?? '')) throw Error(`Missing target DB contract: ${r.id}`)
    if (r.supportFiles !== undefined && (!Array.isArray(r.supportFiles) || new Set(r.supportFiles).size !== r.supportFiles.length || r.supportFiles.some(f => typeof f !== 'string' || !Object.hasOwn(files, f)))) throw Error(`Missing or invalid support files: ${r.id}`)
    if (!r.files?.length) throw Error(`Missing test files: ${r.id}`)
    const complete = Array.isArray(r.expectedTests) && r.expectedTests.length > 0 && r.expectedTests.every(n => typeof n === 'string' && n.trim()) && Number.isInteger(r.expectedCount) && r.expectedCount === r.expectedTests.length
    if (!complete) {
      if (r.status === 'ready') throw Error(`Missing complete test names/count: ${r.id}`)
      contractErrors.push(`Missing complete test names/count: ${r.id}`)
    }
    const command = r.packageScript ? scripts[r.packageScript] : r.command.join(' ')
    if (!command || (r.packageScript && JSON.stringify(r.command) !== JSON.stringify(['pnpm', '-s', r.packageScript]))) throw Error(`Missing or mismatched package command: ${r.id}`)
    if (r.runner && (!files[r.runner] || !command.split(/\s+/).includes(r.runner))) throw Error(`Missing live runner: ${r.id}`)
    for (const f of r.files) {
      if (!Object.hasOwn(files, f.path) || exempt.has(f.path)) throw Error(`Missing/overlapping suite: ${f.path}`)
      if (!Array.isArray(f.requiredNames) || !f.requiredNames.length || f.requiredNames.some(n => typeof n !== 'string' || !n.trim())) throw Error(`Missing test names: ${f.path}`)
      if (complete && f.requiredNames.some(n => !r.expectedTests.includes(n))) throw Error(`Expected tests omit suite anchor: ${f.path}`)
      const invoked = r.runner ? files[r.runner].includes(f.path) : command.split(/\s+/).includes(f.path)
      if (!invoked) throw Error(`Command no longer invokes ${f.path}: ${r.id}`)
      if (!r.variantOf) {
        if (coverage.has(f.path)) throw Error(`Duplicate primary coverage: ${f.path}`)
        coverage.set(f.path, r.id)
      }
    }
    if (r.variantOf) {
      const parent = config.recipes.find(x => x.id === r.variantOf && !x.variantOf)
      if (!parent || !parent.aliases?.includes(r.packageScript) || r.files.some(f => !parent.files.some(p => p.path === f.path))) throw Error(`Invalid explicit variant: ${r.id}`)
    }
  }
  for (const f of databaseFiles(files)) if (!exempt.has(f) && !coverage.has(f)) throw Error(`Unregistered DB suite: ${f}`)
  for (const { marker, file } of required) if (Object.hasOwn(files, marker) && !coverage.has(file)) throw Error(`Required feature suite missing: ${file}`)
  // Bind evidence to the complete reviewed configuration, invoked commands, suite and runner bytes.
  const sourceFiles = [...new Set(config.recipes.flatMap(r => [...r.files.map(f => f.path), ...(r.supportFiles ?? []), ...(r.runner ? [r.runner] : [])]))].sort()
  const digest = createHash('sha256').update(JSON.stringify({ config, commands: config.recipes.map(r => r.packageScript ? scripts[r.packageScript] : r.command), sources: sourceFiles.map(f => [f, files[f]]) })).digest('hex')
  return { version: 1, digest, contractErrors, expected: sorted(ids), recipes: config.recipes, profiles, files: sorted(coverage.keys()), selfManaged: sorted(exempt) }
}
export function databaseIdentity(value) {
  const u = new URL(value)
  const host = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) ? 'loopback' : u.hostname.toLowerCase()
  return JSON.stringify([host, u.port || '5432', decodeURIComponent(u.pathname.slice(1))])
}
export function profileEnvironment(profile, env, phase) {
  if (!((env.CI === 'true' && env.GITHUB_ACTIONS === 'true') || env.MIKKA_ISOLATED_R0 === '1')) throw Error('Explicit isolated R0 execution required')
  if (profile.githubServiceOnly && !(env.CI === 'true' && env.GITHUB_ACTIONS === 'true')) throw Error('Profile requires the GitHub CI service branch')
  const child = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG'].filter(k => env[k]).map(k => [k, env[k]]))
  Object.assign(child, { CI: 'true', REQUIRE_DB: '1', CONVERSATION_READS_REQUIRE_DB: '1', RETAIN_SYNTHETIC_RECORDS: '1', KEEP_GROUP_TEST_FIXTURES: '1' }, profile.env)
  if (env.GITHUB_ACTIONS === 'true') child.GITHUB_ACTIONS = 'true'
  else Object.assign(child, { MIKKA_ISOLATED_R0: '1', MIKKA_ISOLATED_DATA_TEST: '1', MIKKA_ISOLATED_VISIBILITY_TEST: '1', MIKKA_ISOLATED_HISTORY_TEST: '1' })
  for (const t of profile.targets) {
    let u
    try { u = new URL(env[t.key]) } catch { throw Error(`Missing target: ${t.key}`) }
    if (!['postgres:', 'postgresql:'].includes(u.protocol) || (t.protocol && u.protocol !== t.protocol) || u.hostname !== t.host || (u.port || '5432') !== t.port || u.search || u.hash || (t.database && u.pathname !== `/${t.database}`) || (t.suffix && !u.pathname.endsWith(t.suffix)) || (t.user && u.username !== t.user)) throw Error(`Invalid isolated target: ${t.key}`)
  }
  if (profile.distinct && new Set(profile.distinct.map(k => databaseIdentity(env[k]))).size !== profile.distinct.length) throw Error('Separate databases required')
  if (profile.http) {
    let u
    try { u = new URL(env[profile.http]) } catch { throw Error('Postbuild HTTP origin missing') }
    if (phase !== 'postbuild' || u.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(u.hostname) || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw Error('Invalid postbuild HTTP origin')
  }
  for (const [key, source] of Object.entries(profile.bindings)) {
    if (!env[source]) throw Error(`Missing profile binding: ${source}`)
    child[key] = env[source]
  }
  if (child.RETAIN_SYNTHETIC_RECORDS !== '1' || child.KEEP_GROUP_TEST_FIXTURES !== '1') throw Error('Cleanup must remain disabled')
  return child
}
export function parseEvidence(output) {
  // eslint-disable-next-line no-control-regex -- Strip terminal ANSI escapes before reading test records.
  const text = output.replace(/\x1b\[[0-9;]*m/g, '')
  const counts = {}
  for (const [, key, n] of text.matchAll(/^(?:# |ℹ )(tests|pass|fail|skipped|todo|cancelled) (\d+)\s*$/gm)) counts[key] = (counts[key] ?? 0) + Number(n)
  const names = []
  for (const line of text.split('\n')) {
    const tap = /^\s*ok \d+ - (.*?)(?:\s+#.*)?$/.exec(line)
    const spec = /^\s*✔ (.*?)(?: \([\d.]+m?s\))?$/.exec(line)
    if (tap || spec) names.push((tap ?? spec)[1])
  }
  return { counts, names }
}
export function resultError(recipe, result) {
  if (result.state !== 'passed' || result.exitCode !== 0) return `${recipe.id}: did not pass (${result.state})`
  if (!Array.isArray(recipe.expectedTests) || !recipe.expectedTests.length || recipe.expectedCount !== recipe.expectedTests.length) return `${recipe.id}: missing complete test names/count contract`
  const c = result.counts
  if (!c || ['tests', 'pass', 'fail', 'skipped', 'todo', 'cancelled'].some(k => !Number.isInteger(c[k]) || c[k] < 0)) return `${recipe.id}: missing test counts`
  if (c.tests !== recipe.expectedCount || c.pass !== c.tests || c.fail || c.skipped || c.todo || c.cancelled) return `${recipe.id}: incomplete/skipped test summary`
  if (!Array.isArray(result.names) || JSON.stringify(sorted(result.names)) !== JSON.stringify(sorted(recipe.expectedTests))) return `${recipe.id}: test name multiset mismatch`
  return null
}
/** Keep only scalar failure facts and source locations; never retain bodies/tokens/URLs. */
export function failureDiagnostics(output) {
  const codes = [...output.matchAll(/^\s*code:\s*['"]?(ERR_[A-Z0-9_]+|[0-9A-Z]{5})['"]?\s*$/gm)].map(m=>m[1])
  const assertions = [...output.matchAll(/^\s*(expected|actual):\s*(-?\d+(?:\.\d+)?|true|false|null)\s*$/gm)].map(m=>({kind:m[1],value:JSON.parse(m[2])}))
  const locations = [...output.matchAll(/(?:^|[\s/(])((?:tests|lib|scripts)\/[a-zA-Z0-9_./-]+\.(?:ts|mjs|js):\d+(?::\d+)?)/gm)].map(m=>m[1])
  return {codes:[...new Set(codes)].slice(0,12),assertions:assertions.slice(0,24),locations:[...new Set(locations)].slice(0,20)}
}
export function executePhase(plan, phase, sha, env, run) {
  if (!PHASES.includes(phase) || !/^[a-f0-9]{40}$/.test(sha)) throw Error('Exact SHA and explicit phase required')
  const results = []
  for (const recipe of plan.recipes.filter(r => r.phase === phase)) {
    const result = { id: recipe.id, phase, sha, digest: plan.digest, profile: recipe.profile, command: recipe.command, state: 'blocked', exitCode: null, counts: null, names: [] }
    if (phase === 'postbuild' && env.R0_BUILD_SUCCEEDED !== 'success') result.reason = 'Postbuild phase requires successful build outcome'
    else if (recipe.status === 'pending') result.reason = recipe.pendingReason
    else try {
      const child = profileEnvironment(plan.profiles[recipe.profile], env, phase)
      const execution = run(recipe.command[0], recipe.command.slice(1), { encoding: 'utf8', env: child, shell: false, maxBuffer: 64 << 20 })
      Object.assign(result, parseEvidence(`${execution.stdout ?? ''}\n${execution.stderr ?? ''}`), { state: 'passed', exitCode: execution.status })
      const error = resultError(recipe, result)
      if (error) { result.state = 'failed'; result.reason = error; result.diagnostics = failureDiagnostics(`${execution.stdout ?? ''}\n${execution.stderr ?? ''}`) }
    } catch (e) { result.state = 'failed'; result.reason = e.message }
    results.push(result)
  }
  return { version: 1, phase, sha, digest: plan.digest, results }
}
export function aggregate(plan, sha, reports) {
  const errors = [...(plan.contractErrors ?? [])], seen = new Set(), phases = new Set()
  for (const report of reports) {
    if (!report || report.version !== 1 || report.sha !== sha || report.digest !== plan.digest || !PHASES.includes(report.phase) || phases.has(report.phase) || !Array.isArray(report.results)) { errors.push('Foreign, duplicate or invalid phase report'); continue }
    phases.add(report.phase)
    for (const result of report.results) {
      const recipe = plan.recipes.find(r => r.id === result.id)
      if (!recipe || seen.has(result.id) || result.sha !== sha || result.digest !== plan.digest || result.phase !== recipe.phase || report.phase !== recipe.phase || result.profile !== recipe.profile || JSON.stringify(result.command) !== JSON.stringify(recipe.command)) { errors.push(`Foreign/duplicate result: ${result.id}`); continue }
      seen.add(result.id)
      if (recipe.status !== 'ready') errors.push(`Recipe still pending: ${recipe.id}`)
      const error = resultError(recipe, result)
      if (error) errors.push(error)
    }
  }
  for (const id of plan.expected) if (!seen.has(id)) errors.push(`Missing recipe result: ${id}`)
  return { sha, digest: plan.digest, expected: plan.expected, passed: !errors.length, errors }
}
