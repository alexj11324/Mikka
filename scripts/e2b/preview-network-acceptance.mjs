#!/usr/bin/env node
/** Fixed-source E2B ingress acceptance. Credentials stay in this process.
 * The disposable servers return synthetic markers, never files or headers.
 * No model call, browser, production database or existing task is used. */
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Sandbox } from 'e2b'

const MARKER = 'mikka-preview-network-synthetic-v1'
const SERVER = `import http.server,json,socket,threading
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  body=b'${MARKER}'
  self.send_response(200);self.send_header('Content-Type','text/plain');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
class V6(http.server.ThreadingHTTPServer):address_family=socket.AF_INET6
servers={}
for name,host,kind in [('loopback4','127.0.0.1',http.server.ThreadingHTTPServer),('public4','0.0.0.0',http.server.ThreadingHTTPServer),('loopback6','::1',V6)]:
 try:servers[name]=kind((host,0),Handler)
 except OSError:
  if name!='loopback6':raise
for server in servers.values():threading.Thread(target=server.serve_forever,daemon=True).start()
print(json.dumps({'ready':{name:server.server_address[1] for name,server in servers.items()}}),flush=True)
threading.Event().wait()
`
const fail = (code, cause) => { throw new Error(code, cause ? { cause } : undefined) }

async function sample(url, fetchImpl) {
  try {
    const response = await fetchImpl(url, { redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(12_000) })
    const body = await response.text()
    return { status: response.status, markerMatched: body === MARKER }
  } catch {
    return { status: null, markerMatched: false }
  }
}

export async function probePreviewNetwork(sandbox, sourceCommit, fetchImpl = fetch) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) fail('preview_probe_source_invalid')
  const firewall = await readFile(new URL('./preview_firewall.py', import.meta.url), 'utf8')
  const report = { sourceCommit, templateId: (await sandbox.getInfo()).templateId, sandboxId: sandbox.sandboxId,
    firewallSha256: createHash('sha256').update(firewall).digest('hex'), observedAt: new Date().toISOString(),
    before: {}, protected: {}, after: {}, local: {}, passed: false }
  await sandbox.commands.run('install -d -m 700 /run/mikka-preview-probe; install -d -m 700 -o user -g user /home/user/mikka-preview-probe', { user: 'root', timeoutMs: 10_000 })
  await sandbox.files.write('/home/user/mikka-preview-probe/server.py', SERVER, { user: 'user' })
  await sandbox.files.write('/run/mikka-preview-probe/preview_firewall.py', firewall, { user: 'root' })
  let ready, refused, buffer = ''
  const pending = new Promise((accept, reject) => { ready = accept; refused = reject })
  const timer = setTimeout(() => refused(new Error('preview_probe_start_timeout')), 20_000)
  let ports
  try {
    const process = await sandbox.commands.run('exec python3 /home/user/mikka-preview-probe/server.py', {
      user: 'user', background: true, timeoutMs: 0, onStderr: () => {}, onStdout: text => {
        buffer += text
        if (buffer.length > 2048) { refused(new Error('preview_probe_output_invalid')); return }
        if (buffer.includes('\n')) {
          try { ready(JSON.parse(buffer.split('\n')[0]).ready) }
          catch (cause) { refused(new Error('preview_probe_output_invalid', { cause })) }
        }
      },
    })
    void process.wait().then(() => refused(new Error('preview_probe_exited')), cause => refused(new Error('preview_probe_process_failed', { cause })))
    ports = await pending
  } finally { clearTimeout(timer) }
  if (!ports || !ports.loopback4 || !ports.public4
    || Object.values(ports).some(port => !Number.isInteger(port) || port <= 1024 || port >= 65536)
    || new Set(Object.values(ports)).size !== Object.keys(ports).length
    || Object.keys(ports).some(name => !['loopback4', 'public4', 'loopback6'].includes(name))) fail('preview_probe_ports_invalid')

  // One bounded external setup wait: envd scans loopback listeners once per
  // second before starting its socat forward. This is not a product poll.
  await new Promise(resolveReady => setTimeout(resolveReady, 1500))
  for (const [name, port] of Object.entries(ports)) report.before[name] = await sample(`https://${sandbox.getHost(port)}/`, fetchImpl)
  if (!report.before.public4.markerMatched) fail('preview_probe_positive_control_failed')
  for (const name of ['loopback4', 'loopback6']) {
    if (!ports[name]) continue
    let result
    try { result = await sandbox.commands.run(`python3 /run/mikka-preview-probe/preview_firewall.py ${ports[name]}`, { user: 'root', timeoutMs: 45_000 }) }
    catch (cause) {
      let refusal
      try { refusal = JSON.parse(cause?.stdout ?? '') } catch { /* Only closed diagnostic codes enter evidence. */ }
      const code = ['firewall_unsupported', 'firewall_unavailable'].includes(refusal?.code) ? refusal.code : 'firewall_unverified'
      report.failure = code
      const error = new Error('preview_probe_' + code, { cause })
      error.evidence = report
      throw error
    }
    report.protected[name] = JSON.parse(result.stdout)
    if (report.protected[name].protected !== true || report.protected[name].ipv4 !== true || report.protected[name].ipv6 !== true)
      fail('preview_probe_firewall_unverified')
    report.after[name] = await sample(`https://${sandbox.getHost(ports[name])}/`, fetchImpl)
  }
  report.after.public4 = await sample(`https://${sandbox.getHost(ports.public4)}/`, fetchImpl)
  const command = `python3 - <<'MIKKA_SYNTHETIC_LOCAL_CHECK'\nimport json,urllib.request\nopener=urllib.request.build_opener(urllib.request.ProxyHandler({}))\nports=${JSON.stringify(ports)}\nresult={}\nfor name in ['loopback4','loopback6']:\n if name not in ports:continue\n host='[::1]' if name=='loopback6' else '127.0.0.1'\n result[name]=opener.open('http://'+host+':'+str(ports[name])+'/',timeout=5).read()==b'${MARKER}'\nprint(json.dumps(result))\nMIKKA_SYNTHETIC_LOCAL_CHECK`
  report.local = JSON.parse((await sandbox.commands.run(command, { user: 'root', timeoutMs: 15_000 })).stdout)
  report.passed = report.after.public4.markerMatched && Object.keys(report.protected).every(name =>
    report.local[name] === true && report.after[name].markerMatched === false)
  return report
}

async function main(args) {
  const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
  const template = option('--template') ?? 'claude'
  const output = option('--output')
  if (!output || !/^[A-Za-z0-9_-]{1,128}$/.test(template) || !process.env.E2B_API_KEY) fail('preview_probe_configuration')
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const sandbox = await Sandbox.create(template, { apiKey: process.env.E2B_API_KEY, proxy: process.env.HTTPS_PROXY ?? process.env.https_proxy,
    timeoutMs: 180_000, network: { allowPublicTraffic: true }, lifecycle: { onTimeout: 'kill', autoResume: false },
    metadata: { application: 'mikka-preview-network-acceptance', issue: '1724', sourceCommit, fixtureId: randomUUID() } })
  let report
  let failure
  try {
    report = await probePreviewNetwork(sandbox, sourceCommit)
  } catch (error) {
    failure = error
    report = error.evidence ?? { sourceCommit, sandboxId: sandbox.sandboxId, passed: false,
      failure: /^preview_probe_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'preview_probe_failed' }
  } finally {
    try {
      const stopped = await sandbox.kill()
      if (report) report.cleanup = { stopped: stopped !== false }
      if (stopped === false) failure = new Error('preview_probe_cleanup_unverified', failure ? { cause: failure } : undefined)
    } catch (cause) {
      if (report) report.cleanup = { stopped: false }
      failure = new Error('preview_probe_cleanup_unverified', { cause })
    }
  }
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
  if (failure) throw failure
  if (!report.passed) fail('preview_probe_ingress_not_private')
  console.log(JSON.stringify({ sourceCommit, passed: true, evidence: resolve(output) }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    const code = /^preview_probe_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'preview_probe_failed'
    console.error(JSON.stringify({ passed: false, code, causeName: error?.cause?.name ?? error?.name ?? 'unknown' }))
    process.exitCode = 1
  })
}
