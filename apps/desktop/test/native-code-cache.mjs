import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const fixture = fileURLToPath(new URL('./fixtures/native-code-cache.cjs', import.meta.url))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

/** Read the actual registration without executing the application's main. */
export function registeredScheme(source) {
  const file = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
  const calls = []
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'protocol.registerSchemesAsPrivileged') calls.push(node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.equal(calls.length, 1)
  const literal = node => {
    if (ts.isStringLiteral(node)) return node.text
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal)
    assert.ok(ts.isObjectLiteralExpression(node))
    return Object.fromEntries(node.properties.map(property => {
      assert.ok(ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)))
      return [property.name.text, literal(property.initializer)]
    }))
  }
  assert.equal(calls[0].arguments.length, 1)
  const result = literal(calls[0].arguments[0])
  assert.equal(result.length, 1); assert.equal(result[0].scheme, 'mikka')
  return result[0]
}

async function cacheFiles(directory) {
  let dataFiles = 0, dataBytes = 0
  const walk = async path => {
    for (const entry of await readdir(path, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error })) {
      assert.equal(entry.isSymbolicLink(), false)
      if (entry.isDirectory()) await walk(join(path, entry.name))
      else if (entry.isFile() && !['index', 'the-real-index'].includes(entry.name)) {
        dataFiles++; dataBytes += (await readFile(join(path, entry.name))).length
      }
    }
  }
  await walk(directory)
  return { dataFiles, dataBytes }
}

export async function runCodeCacheProbe(executablePath, output) {
  const source = await readFile(join(root, 'apps/desktop/src/main/index.ts'), 'utf8')
  const scheme = registeredScheme(source)
  assert.equal(scheme.privileges.codeCache, true)
  assert.equal(scheme.privileges.standard, true)
  assert.ok(executablePath && resolve(executablePath) === executablePath)
  assert.notEqual(process.getuid?.(), 0, 'Use the owned non-root native test user')
  const directory = await mkdtemp(join(tmpdir(), 'mikka-code-cache-'))
  const report = { version: 1, revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    sourceSha256: sha256(source), fixtureSha256: sha256(await readFile(fixture)), status: 'pending',
    method: 'two fresh processes per scheme setting; three ordinary module navigations per process; default V8 heat checks',
    productColdBenchmark: false, samples: [], cleanup: 'pending' }
  let failure
  try {
    for (const enabled of [false, true]) {
      const profile = join(directory, enabled ? 'enabled' : 'control')
      await mkdir(profile)
      const config = join(profile, 'fixture.json')
      await writeFile(config, JSON.stringify({ profile, cache: join(profile, 'code-cache'), scheme: { ...scheme, privileges: { ...scheme.privileges, codeCache: enabled } } }), { mode: 0o600 })
      for (let processNumber = 1; processNumber <= 2; processNumber++) {
        const before = await cacheFiles(join(profile, 'code-cache'))
        const env = Object.fromEntries(['PATH', 'HOME', 'SHELL', 'LANG', 'DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []))
        const child = spawn(executablePath, [fixture, config], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = '', stderrBytes = 0, forced = false
        child.stdout.on('data', data => { stdout += data; if (stdout.length > 16_384) { forced = true; child.kill('SIGKILL') } })
        child.stderr.on('data', data => { stderrBytes += data.length })
        const timer = setTimeout(() => { forced = true; child.kill('SIGKILL') }, 30_000)
        let code
        try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }) }
        finally { clearTimeout(timer) }
        assert.equal(forced, false); assert.equal(code, 0); assert.equal(child.exitCode, 0)
        const observed = JSON.parse(stdout)
        assert.equal(observed.status, 'passed'); assert.equal(observed.sandbox, true); assert.equal(observed.nodeIntegration, false)
        assert.equal(observed.codeCache, enabled); assert.equal(observed.navigations, 3)
        report.samples.push({ enabled, processNumber, before, after: await cacheFiles(join(profile, 'code-cache')), ...observed, stderrBytes, processExited: true })
      }
    }
    const controls = report.samples.filter(sample => !sample.enabled)
    const enabled = report.samples.filter(sample => sample.enabled)
    assert.ok(controls.every(sample => sample.after.dataFiles === 0))
    assert.ok(enabled[0].after.dataFiles > 0 && enabled[0].after.dataBytes > 0)
    assert.ok(enabled[1].before.dataFiles > 0 && enabled[1].before.dataBytes > 0, 'normal code cache persists into the next process')
    report.status = 'passed'
  } catch (error) { failure = error; report.status = 'failed'; report.failure = 'NATIVE_CODE_CACHE_PROBE_FAILED' }
  finally {
    try { await rm(directory, { recursive: true }); report.cleanup = 'passed' }
    catch (error) { failure ??= error; report.status = 'failed'; report.cleanup = 'failed' }
    await mkdir(dirname(resolve(output)), { recursive: true })
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  }
  if (failure) throw new Error('NATIVE_CODE_CACHE_PROBE_FAILED', { cause: failure })
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCodeCacheProbe(process.argv[2], process.argv[3]).then(() => console.log('NATIVE_CODE_CACHE_PROBE_PASSED'))
    .catch(() => { console.error('NATIVE_CODE_CACHE_PROBE_FAILED'); process.exitCode = 1 })
}
