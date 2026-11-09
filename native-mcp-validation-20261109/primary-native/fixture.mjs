#!/usr/bin/env node
// Offline native boundary probe. No subscription/API acceptance claim.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { gunzipSync, inflateSync, brotliDecompressSync, zstdDecompressSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';

const [binaryArg, repoArg, outputArg, catalogArg] = process.argv.slice(2);
assert(binaryArg && repoArg && outputArg && catalogArg,
  'Usage: node fixture.mjs ABS_BINARY ABS_MIKKA_REPO NEW_OUTPUT_DIR ABS_OFFICIAL_MODELS_JSON');
const binary = resolve(binaryArg), repo = resolve(repoArg), output = resolve(outputArg), catalog = resolve(catalogArg);
const SOURCE = '869c71d7aa062c76fc7a75c1f8775d1ed8538168';
const UPSTREAM = '6ff1e1ca3b30fc8b914720681fcf5fe62e95f856';
const MODEL_BLOB = '489ebe3f2483348641a16160ce8491dd077eabca';
const SOURCES = {
  'capture-copy.mjs': '3634a4cea39efe7b9f81f8da77d8a71760ef06cc',
  'mikka-mcp-backend.mjs': '308c9ed7ab78b636876fd661b55d36dd61b478d2',
  'mikka-mcp-context.mjs': '7c7bba63cf0780d63f0d1b30f6a5a234d3db7d04',
  'mikka-mcp.mjs': 'e314a1c43ac0749a5a773bcef2be02a976fc166f',
};
const sha = data => createHash('sha256').update(data).digest('hex');
const gitBlob = data => createHash('sha1').update('blob ' + data.length + '\0').update(data).digest('hex');
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const elapsed = start => Math.round((performance.now() - start) * 1000) / 1000;
const MAX = 8 * 1024 * 1024;
mkdirSync(output, { recursive: false, mode: 0o700 });
const sourceDir = join(output, 'original-mikka');
mkdirSync(sourceDir, { mode: 0o700 });
const sources = [];
for (const [name, expected] of Object.entries(SOURCES)) {
  const path = 'packages/daemon/src/agents/' + name;
  const data = execFileSync('git', ['-C', repo, 'show', SOURCE + ':' + path], { maxBuffer: MAX, timeout: 5000 });
  assert.equal(gitBlob(data), expected, 'fixed source mismatch: ' + name);
  writeFileSync(join(sourceDir, name), data, { mode: 0o600 });
  sources.push({ path, gitBlob: expected, bytes: data.length, sha256: sha(data) });
}
const modelBytes = readFileSync(catalog);
assert.equal(gitBlob(modelBytes), MODEL_BLOB, 'official model catalogue bytes changed');
assert(JSON.parse(modelBytes).models.some(model => model.slug === 'gpt-6-luna'));
const binaryBytes = readFileSync(binary);
assert.equal(binaryBytes.length, 319346888, 'official binary size mismatch');
assert.equal(sha(binaryBytes), 'b8a11fedf24b2dfb59a70c9e52b030f9a508dcd49cd2dd0d41956f4c785156b8', 'official binary hash mismatch');
const provenance = { source: SOURCE, upstream: UPSTREAM, model: 'gpt-6-luna',
  binary: { path: binary, bytes: binaryBytes.length, sha256: sha(binaryBytes) },
  catalogue: { gitBlob: MODEL_BLOB, bytes: modelBytes.length, sha256: sha(modelBytes), modified: false },
  sources, directModelOverrides: [], requiredOverride: false, optionalGraceOverride: false,
  scope: 'synthetic native RPC boundary; not full daemon adoption, production, subscription, performance acceptance, or historical attribution' };
json(join(output, 'provenance.json'), provenance);

function bounded(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), ms); })])
    .finally(() => clearTimeout(timer));
}
function namesInTools(body) {
  const arrays = [];
  function scan(value, path = '$') {
    if (Array.isArray(value)) { value.forEach((v, i) => scan(v, path + '[' + i + ']')); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'tools' && Array.isArray(item)) arrays.push({ path: path + '.tools', value: item });
      scan(item, path + '.' + key);
    }
  }
  scan(body);
  const names = [];
  const types = [];
  for (const group of arrays) {
    function walk(value) {
      if (Array.isArray(value)) return value.forEach(walk);
      if (!value || typeof value !== 'object') return;
      if (typeof value.name === 'string') names.push(value.name);
      if (typeof value.type === 'string') types.push(value.type);
      Object.values(value).forEach(walk);
    }
    walk(group.value);
  }
  const unique = [...new Set(names)].sort();
  const has = suffix => unique.some(name => name === suffix || name.endsWith('__' + suffix) || name.endsWith('.' + suffix));
  return { toolArrayPaths: arrays.map(group => group.path), toolArrayLengths: arrays.map(group => group.value.length),
    names: unique, types: [...new Set(types)].sort(),
    inspect_artifact: has('inspect_artifact'), inspect_repository: has('inspect_repository'), submit: has('submit'),
    toolArraysSha256: sha(Buffer.from(JSON.stringify(arrays))),
    interpretation: 'Named definitions in captured tools arrays only; false is not proof of unavailable code/search-mediated capability.' };
}
function wsFrame(value, opcode = 1) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  let head;
  if (body.length < 126) { head = Buffer.from([0x80 | opcode, body.length]); }
  else if (body.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(body.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(body.length), 2); }
  return Buffer.concat([head, body]);
}
const results = [];
let activePid;
const trackedChildren = new Set();
function collectDescendants(root) {
  const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf8', timeout: 1000, maxBuffer: MAX })
    .trim().split('\n').map(line => line.trim().split(/\s+/)).map(([pid, ppid, pgid, state]) => ({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), state }));
  const ids = new Set([root]); let changed = true;
  while (changed) { changed = false; for (const row of rows) if (ids.has(row.ppid) && !ids.has(row.pid)) { ids.add(row.pid); changed = true; } }
  for (const pid of ids) if (pid !== root) trackedChildren.add(pid);
  return rows.filter(row => ids.has(row.pid) || trackedChildren.has(row.pid));
}
const hardTimer = setTimeout(() => {
  if (activePid) { try { collectDescendants(activePid); } catch {} try { process.kill(-activePid, 'SIGKILL'); } catch {} }
  for (const pid of trackedChildren) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  process.stderr.write('fixture overall 105 s hard deadline\n');
  process.exit(124);
}, 105_000);

async function runCase(mode) {
  const caseDir = join(output, mode), started = performance.now(), marker = 'SYNTHETIC_MCP_FIRST_TURN_' + randomUUID();
  mkdirSync(caseDir, { mode: 0o700 });
  const home = join(caseDir, 'user-home'), workspace = join(caseDir, 'workspace'), contextDir = join(caseDir, 'mcp-contexts');
  for (const dir of [home, workspace, contextDir]) mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(workspace, 'synthetic.txt'), 'Only synthetic fixture content.\n', { mode: 0o600 });
  const env = { HOME: home, CODEX_HOME: join(home, '.codex'),
    PATH: dirname(process.execPath) + ':/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    TMPDIR: caseDir, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
  const sockets = new Set(), requests = [], rpcEvents = [], notifications = [], stderr = [];
  let totalRpcBytes = 0, totalStderr = 0, child, childExit, capturedResolve;
  let firstRequest;
  const captured = new Promise(resolve => { capturedResolve = resolve; });
  const responseEvents = [
    { type: 'response.created', response: { id: 'resp-synthetic-' + mode } },
    { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'msg-synthetic-' + mode,
      content: [{ type: 'output_text', text: 'synthetic fixture complete' }] } },
    { type: 'response.completed', response: { id: 'resp-synthetic-' + mode,
      usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } },
  ];
  function observe(body, transport, route) {
    const item = { n: requests.length + 1, atMs: elapsed(started), transport, route,
      syntheticInputPresent: JSON.stringify(body).includes(marker), body };
    requests.push(item);
    if (item.syntheticInputPresent && !firstRequest) { firstRequest = item; capturedResolve(item); }
    if (requests.length > 8) throw Error('model request count bound');
  }
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > MAX) throw Error('HTTP body bound'); chunks.push(chunk); }
      let raw = Buffer.concat(chunks);
      const encoding = req.headers['content-encoding'];
      if (encoding === 'gzip') raw = gunzipSync(raw, { maxOutputLength: MAX });
      else if (encoding === 'deflate') raw = inflateSync(raw, { maxOutputLength: MAX });
      else if (encoding === 'br') raw = brotliDecompressSync(raw, { maxOutputLength: MAX });
      else if (encoding === 'zstd') raw = zstdDecompressSync(raw, { maxOutputLength: MAX });
      else if (encoding && encoding !== 'identity') throw Error('unknown content encoding');
      if (req.method !== 'POST' || !/^\/v1\/responses(?:\/lite)?(?:\?.*)?$/.test(req.url ?? '')) {
        res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"fixture route unavailable"}'); return;
      }
      observe(JSON.parse(raw.toString('utf8')), 'http', req.url);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.end(responseEvents.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''));
    } catch (error) { notifications.push({ kind: 'mock_http_error', atMs: elapsed(started), message: String(error.message) }); res.destroy(); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    try {
      assert(/^\/v1\/responses(?:\/lite)?(?:\?.*)?$/.test(req.url ?? ''), 'unexpected WS route');
      assert(typeof req.headers['sec-websocket-key'] === 'string', 'missing WS key');
      const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
      let buffer = head, fragments = [], fragmentBytes = 0;
      function consume(chunk) {
        try {
          buffer = Buffer.concat([buffer, chunk]);
          if (buffer.length > MAX + 14) throw Error('WS frame bound');
          while (buffer.length >= 2) {
            const fin = !!(buffer[0] & 128), opcode = buffer[0] & 15, masked = !!(buffer[1] & 128);
            if (buffer[0] & 112) throw Error('unnegotiated WS compression');
            let length = buffer[1] & 127, offset = 2;
            if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
            if (length === 127) { if (buffer.length < 10) return; const n = buffer.readBigUInt64BE(2); if (n > BigInt(MAX)) throw Error('WS length bound'); length = Number(n); offset = 10; }
            if (!masked) throw Error('client WS frame must be masked');
            if (buffer.length < offset + 4 + length) return;
            const mask = buffer.subarray(offset, offset + 4); offset += 4;
            const payload = Buffer.from(buffer.subarray(offset, offset + length));
            for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
            buffer = buffer.subarray(offset + length);
            if (opcode === 8) { socket.end(wsFrame(payload, 8)); return; }
            if (opcode === 9) { socket.write(wsFrame(payload, 10)); continue; }
            if (opcode === 10) continue;
            if (![0, 1, 2].includes(opcode)) throw Error('unsupported WS opcode');
            fragments.push(payload); fragmentBytes += payload.length;
            if (fragmentBytes > MAX) throw Error('WS message bound');
            if (!fin) continue;
            const body = JSON.parse(Buffer.concat(fragments).toString('utf8')); fragments = []; fragmentBytes = 0;
            observe(body, 'websocket', req.url);
            for (const event of responseEvents) socket.write(wsFrame(event));
          }
        } catch (error) { notifications.push({ kind: 'mock_ws_error', atMs: elapsed(started), message: String(error.message) }); socket.destroy(); }
      }
      socket.on('data', consume);
      if (head.length) consume(Buffer.alloc(0));
    } catch (error) { notifications.push({ kind: 'mock_upgrade_error', atMs: elapsed(started), message: String(error.message) }); socket.destroy(); }
  });
  let outcome = { mode, ok: false, initializeDelayMs: 0, marker, observed: false };
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port, baseUrl = 'http://127.0.0.1:' + port + '/v1';
    // Both provider and model retain WebSocket support. No transport downgrade.
    const args = ['app-server', '-c', 'model="gpt-6-luna"', '-c', 'model_provider="fixture"',
      '-c', 'model_catalog_json=' + JSON.stringify(catalog),
      '-c', 'model_providers.fixture.name="Synthetic loopback fixture"',
      '-c', 'model_providers.fixture.base_url=' + JSON.stringify(baseUrl),
      '-c', 'model_providers.fixture.wire_api="responses"',
      '-c', 'model_providers.fixture.requires_openai_auth=false',
      '-c', 'model_providers.fixture.supports_websockets=true',
      '-c', 'model_providers.fixture.request_max_retries=0', '-c', 'model_providers.fixture.stream_max_retries=0',
      '-c', 'features.shell_tool=false', '-c', 'otel.exporter="none"', '-c', 'otel.trace_exporter="none"',
      '-c', 'otel.metrics_exporter="none"'];
    const entry = join(sourceDir, 'mikka-mcp.mjs');
    const mcpArgs = [entry, '--handoff', join(caseDir, 'handoff.json'), '--factory-artifacts', workspace];
    let threadConfig;
    if (mode === 'cold') {
      args.push('-c', 'mcp_servers.mikka.command=' + JSON.stringify(process.execPath),
        '-c', 'mcp_servers.mikka.args=' + JSON.stringify(mcpArgs));
    } else {
      const runId = randomUUID(), nonce = randomUUID(), path = join(contextDir, runId + '.json');
      writeFileSync(path, JSON.stringify({ version: 1, runId, nonce, args: mcpArgs, env: {} }), { mode: 0o600, flag: 'wx' });
      chmodSync(contextDir, 0o700); chmodSync(path, 0o600);
      threadConfig = { mcp_servers: { mikka: { command: process.execPath,
        args: [join(sourceDir, 'mikka-mcp-context.mjs'), path, runId, nonce], env: {} } } };
    }
    json(join(caseDir, 'command.json'), { binary, args, cwd: workspace, envKeys: Object.keys(env),
      ordinaryCodexHome: env.CODEX_HOME === join(env.HOME, '.codex'), threadConfig: threadConfig ?? null,
      accountLoginSent: false, nativeModelCatalogueUnchanged: true });
    child = spawn(binary, args, { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    activePid = child.pid;
    child.stdin.on('error', error => notifications.push({ kind: 'stdin_error', message: String(error.message) }));
    childExit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    child.on('error', error => notifications.push({ kind: 'spawn_error', message: String(error.message) }));
    const pending = new Map();
    createInterface({ input: child.stdout }).on('line', line => {
      totalRpcBytes += Buffer.byteLength(line) + 1;
      if (totalRpcBytes > MAX) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} return; }
      try {
        const message = JSON.parse(line); rpcEvents.push({ atMs: elapsed(started), message });
        if (message.id !== undefined && pending.has(message.id)) {
          const waiter = pending.get(message.id); pending.delete(message.id);
          if (message.error) waiter.reject(Error('native RPC ' + JSON.stringify(message.error)));
          else waiter.resolve(message.result);
        } else if (message.method) notifications.push({ atMs: elapsed(started), ...message });
      } catch {}
    });
    child.stderr.on('data', chunk => { totalStderr += chunk.length; if (totalStderr <= MAX) stderr.push(chunk); });
    let id = 0;
    const send = (method, params) => {
      const request = { jsonrpc: '2.0', id: ++id, method, params };
      rpcEvents.push({ atMs: elapsed(started), direction: 'send', message: request });
      return new Promise((resolve, reject) => {
        pending.set(request.id, { resolve, reject });
        child.stdin.write(JSON.stringify(request) + '\n');
      });
    };
    const workflow = async () => {
      const initialized = await send('initialize', { clientInfo: { name: 'mikka-native-fixture', title: 'Synthetic native boundary probe', version: '1.0.0' },
        capabilities: { experimentalApi: true } });
      outcome.userAgent = initialized.userAgent ?? null;
      assert(/\/0\.166\.0(?:\s|$)/.test(initialized.userAgent ?? ''), 'native version guard');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n');
      const response = await send('thread/start', { cwd: workspace, model: 'gpt-6-luna', approvalPolicy: 'never',
        sandbox: 'danger-full-access', developerInstructions: 'This is a synthetic offline protocol fixture. No external work is requested.',
        ...(threadConfig ? { config: threadConfig } : {}) });
      outcome.threadStartedAtMs = elapsed(started);
      const turn = send('turn/start', { threadId: response.thread.id,
        input: [{ type: 'text', text: marker + '\nRespond with the literal word fixture.', text_elements: [] }] });
      // Do not add status/list or readiness waits before first request.
      const actual = await captured;
      outcome = { ...outcome, ok: true, observed: true, firstRequestAtMs: actual.atMs,
        transport: actual.transport, route: actual.route, catalogue: namesInTools(actual.body) };
      await bounded(turn, 2000, 'turn ACK after captured first request').catch(error => {
        outcome.turnAckError = String(error.message);
      });
      await delay(200);
    };
    await bounded(workflow(), 45_000, 'case 45 s deadline');
  } catch (error) {
    outcome.error = String(error.message);
  } finally {
    if (child?.pid) {
      try { outcome.descendantsBeforeCleanup = collectDescendants(child.pid); } catch (error) { outcome.descendantScanError = String(error.message); }
      child.stdin.end();
      await delay(300);
      try { collectDescendants(child.pid); } catch {}
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      for (const pid of trackedChildren) { try { process.kill(pid, 'SIGTERM'); } catch {} }
      await delay(300);
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      for (const pid of trackedChildren) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      outcome.childExit = await bounded(childExit, 1500, 'native parent reaping deadline').catch(error => ({ error: String(error.message) }));
      for (let attempt = 0; attempt < 10; attempt++) {
        try { process.kill(-child.pid, 0); outcome.processGroupGone = false; } catch (error) { outcome.processGroupGone = error.code === 'ESRCH'; }
        if (outcome.processGroupGone) break;
        await delay(100);
      }
      try { outcome.descendantsAfterCleanup = collectDescendants(child.pid); } catch (error) { outcome.descendantScanError = String(error.message); }
      outcome.liveDescendantsAfterCleanup = (outcome.descendantsAfterCleanup ?? []).filter(row => !row.state.startsWith('Z'));
      if (outcome.liveDescendantsAfterCleanup.length) outcome.processGroupGone = false;
      trackedChildren.clear();
    }
    activePid = undefined;
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    outcome.totalMs = elapsed(started); outcome.modelRequestCount = requests.length;
    json(join(caseDir, 'native-rpc.json'), rpcEvents);
    json(join(caseDir, 'notifications.json'), notifications);
    json(join(caseDir, 'model-requests.synthetic.json'), requests);
    writeFileSync(join(caseDir, 'native.stderr.txt'), Buffer.concat(stderr), { mode: 0o600 });
    json(join(caseDir, 'result.json'), outcome);
  }
  return outcome;
}
try {
  for (const mode of ['cold', 'adopted']) {
    const result = await runCase(mode); results.push(result); console.log(JSON.stringify(result));
    if (!result.observed || result.processGroupGone !== true) break;
  }
  const summary = { ...provenance, results, allFirstRequestsObserved: results.length === 2 && results.every(r => r.observed),
    allProcessGroupsGone: results.length === 2 && results.every(r => r.processGroupGone === true),
    claim: 'No catalogue-loss or performance conclusion follows from named booleans alone when official metadata uses code/search representations.' };
  json(join(output, 'summary.json'), summary);
  process.exitCode = summary.allFirstRequestsObserved && summary.allProcessGroupsGone ? 0 : 1;
} finally { clearTimeout(hardTimer); }
