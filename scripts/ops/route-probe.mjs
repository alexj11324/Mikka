import assert from 'node:assert/strict'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
const placeholder = '__mikka_route_probe__'

/** Inspect the existing dispatch contract without invoking a route handler.
 * An undeclared OPTIONS is answered by the API dispatcher with 204 + Allow.
 * Routes declaring OPTIONS use another undeclared method and require 405 +
 * Allow. Do not replace this with GET: several GET handlers start real work. */
export function routeProbePlan(manifest) {
  assert.ok(manifest?.version === 1 && manifest.basePath === '/mikka'
    && Array.isArray(manifest.routes) && manifest.routes.length > 0, 'route_probe_manifest_invalid')
  const paths = new Set()
  return manifest.routes.map(route => {
    assert.ok(typeof route.path === 'string' && route.path.startsWith('/mikka/')
      && !/[?#\\%\s]/.test(route.path) && !route.path.includes('//')
      && !paths.has(route.path), 'route_probe_path_invalid')
    paths.add(route.path)
    assert.ok(Array.isArray(route.methods) && route.methods.length > 0
      && route.methods.every(method => methods.includes(method))
      && new Set(route.methods).size === route.methods.length, 'route_probe_methods_invalid')
    const segments = route.path.split('/').map(segment => {
      if (/^\[(?:\.\.\.)?[^\[\]]+\]$/.test(segment) || /^\[\[\.\.\.[^\[\]]+\]\]$/.test(segment)) return placeholder
      assert.ok(!/[\[\]]/.test(segment) && !['.', '..'].includes(segment), 'route_probe_path_invalid')
      return segment
    })
    const allowed = new Set(route.methods)
    if (allowed.has('GET')) allowed.add('HEAD')
    allowed.add('OPTIONS')
    const method = route.methods.includes('OPTIONS')
      ? ['PUT', 'PATCH', 'DELETE', 'POST', 'HEAD', 'GET'].find(candidate => !allowed.has(candidate))
      : 'OPTIONS'
    // A future route implementing every method needs an explicit safe probe;
    // silently calling its handler would turn this gate into a business writer.
    assert.ok(method, 'route_probe_safe_method_missing')
    return { route: route.path, path: segments.join('/'), method,
      expectedStatus: method === 'OPTIONS' ? 204 : 405, allowed: [...allowed].sort() }
  })
}

function targetOrigin(baseUrl) {
  let target
  try { target = new URL(baseUrl) } catch { throw new Error('route_probe_origin_invalid') }
  assert.ok((target.protocol === 'https:' || (target.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)))
    && !target.username && !target.password && !target.search && !target.hash
    && ['/', '/mikka', '/mikka/'].includes(target.pathname), 'route_probe_origin_invalid')
  return target.origin
}

/** Anonymous, bounded requests. Reports contain only declared route paths,
 * methods, status codes and closed failure codes; response bodies and request
 * origins never enter logs. A successful result proves route registration and
 * method dispatch, while production-smoke covers authenticated feature reads. */
export async function runRouteProbe({ baseUrl, manifest, fetchImpl = fetch }) {
  const origin = targetOrigin(baseUrl)
  const plan = routeProbePlan(manifest)
  const results = new Array(plan.length)
  let cursor = 0
  async function worker() {
    while (cursor < plan.length) {
      const index = cursor++
      const probe = plan[index]
      const result = { route: probe.route, method: probe.method, status: null, ok: false }
      let response
      try {
        response = await fetchImpl(origin + probe.path, {
          method: probe.method, headers: { accept: 'application/json' },
          credentials: 'omit', redirect: 'manual', cache: 'no-store',
          signal: AbortSignal.timeout(15_000),
        })
        result.status = response.status
        const allowed = (response.headers.get('allow') ?? '').split(',').map(value => value.trim()).filter(Boolean).sort()
        if (response.status !== probe.expectedStatus) result.error = 'route_probe_status'
        else if (allowed.length !== probe.allowed.length || allowed.some((method, i) => method !== probe.allowed[i])) result.error = 'route_probe_allow'
        else result.ok = true
      } catch { result.error = 'route_probe_request_failed' }
      finally { await response?.body?.cancel().catch(() => {}) }
      results[index] = result
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, plan.length) }, worker))
  const failures = results.filter(result => !result.ok)
  return { status: failures.length ? 'fail' : 'pass', total: results.length,
    passed: results.length - failures.length, failed: failures.length, results }
}

export function markdown(report) {
  return ['## API route registration probe', '', `Result: ${report.status}; ${report.passed}/${report.total} routes passed.`, '',
    '| Route | Method | HTTP | Failure |', '| --- | --- | --- | --- |',
    ...(report.results ?? []).filter(result => !result.ok).map(result => `| ${result.route} | ${result.method} | ${result.status ?? 'none'} | ${result.error} |`),
    ...(report.error ? [`Error: ${report.error}`] : []), ''].join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let report
  try {
    const manifest = JSON.parse(await readFile(resolve(process.env.ROUTE_PROBE_MANIFEST ?? 'apps/api/generated/routes.json'), 'utf8'))
    report = await runRouteProbe({ baseUrl: process.env.ROUTE_PROBE_BASE_URL, manifest })
  } catch (error) {
    const code = error instanceof Error && /^route_probe_[a-z_]+$/.test(error.message) ? error.message : 'route_probe_failed'
    report = { status: 'fail', total: 0, passed: 0, failed: 0, results: [], error: code }
  }
  await mkdir('production-smoke-report', { recursive: true })
  await writeFile('production-smoke-report/route-probe.json', JSON.stringify(report, null, 2) + '\n')
  const summary = markdown(report)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary)
  console.log(summary)
  if (report.status !== 'pass') process.exitCode = 1
}
