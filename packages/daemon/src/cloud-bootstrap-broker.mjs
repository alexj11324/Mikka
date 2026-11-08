// Built once into the selected Mikka worker; never overwrite an official CLI.
// The server hashes these exact bytes before executing the installed resource.
export const WORKER_BOOTSTRAP_BROKER_SOURCE = String.raw`
import { constants, openSync, closeSync, fstatSync, readFileSync, realpathSync, statSync, watch, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
const c = JSON.parse(process.argv[1]);
const closedError = (code, cause) => Object.assign(new Error(code, cause ? { cause } : undefined), { code });
const authority = new AbortController();
let watchRegistration, registrationTimer, activeChild, totalTimer, killTimer, committed = false, complete = false;
let resolveCommit, rejectCommit, resolveRegistration, rejectRegistration;
const commit = new Promise((resolve, reject) => { resolveCommit = resolve; rejectCommit = reject; });
const registered = new Promise((resolve, reject) => { resolveRegistration = resolve; rejectRegistration = reject; });
void commit.catch(() => {}); void registered.catch(() => {});
const abort = cause => {
  if (authority.signal.aborted || complete) return;
  authority.abort(cause);
  rejectCommit(cause); rejectRegistration(cause);
  if (activeChild) {
    stopChild(activeChild, 'SIGTERM');
    killTimer = setTimeout(() => { if (activeChild) stopChild(activeChild, 'SIGKILL'); }, 1000);
  }
};
const stopChild = (child, signal) => { try { process.kill(-child.pid, signal); } catch (cause) { if (cause?.code !== 'ESRCH') throw cause; } };
const onSignal = () => abort(closedError('cloud_broker_aborted'));
process.once('SIGTERM', onSignal); process.once('SIGINT', onSignal);
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === expected;
const identity = value => value.runId === c.runId && value.leaseId === c.leaseId && value.version === 1;
let input = '';
const onData = part => {
  input += part.toString('utf8');
  if (Buffer.byteLength(input) > 8192) return abort(closedError('cloud_broker_input_invalid'));
  let newline;
  while ((newline = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, newline); input = input.slice(newline + 1);
    let value;
    try { value = JSON.parse(line); }
    catch (cause) { abort(closedError('cloud_broker_input_invalid', cause)); return; }
    if (keys(value, 'kind,leaseId,runId,version') && identity(value) && value.kind === 'abort') {
      abort(closedError('cloud_broker_aborted')); return;
    }
    if (committed || !keys(value, 'deviceId,files,kind,leaseId,runId,tokenSha256,version,workspaceId') || !identity(value) || value.kind !== 'commit') {
      abort(closedError('cloud_broker_input_invalid')); return;
    }
    committed = true; resolveCommit(value);
  }
};
const onEnd = () => { if (!committed) abort(closedError('cloud_broker_input_ended')); };
const onInputError = cause => abort(closedError('cloud_broker_input_failed', cause));
process.stdin.on('data', onData); process.stdin.once('end', onEnd); process.stdin.once('error', onInputError);
const read = (path, maximum) => {
  let fd;
  try {
    if (realpathSync(dirname(path)) !== dirname(path)) throw closedError('cloud_broker_file_invalid');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== process.getuid() || before.nlink !== 1 || before.mode & 0o022 || before.size > maximum)
      throw closedError('cloud_broker_file_invalid');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
      throw closedError('cloud_broker_file_changed');
    return bytes;
  } finally { if (fd !== undefined) closeSync(fd); }
};
const command = source => new Promise((resolve, reject) => {
  try { authority.signal.throwIfAborted(); } catch (cause) { reject(cause); return; }
  const child = spawn('/bin/sh', ['-c', source], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  activeChild = child;
  let stdout = '', bytes = 0, failure;
  const fail = code => { if (failure) return; failure = closedError(code); stopChild(child, 'SIGTERM'); killTimer = setTimeout(() => stopChild(child, 'SIGKILL'), 1000); };
  const timer = setTimeout(() => fail('cloud_broker_command_timeout'), 10000);
  const capture = part => { bytes += part.length; if (bytes > 4096) fail('cloud_broker_command_output'); };
  child.stdout.on('data', part => { capture(part); if (bytes <= 4096) stdout += part.toString('utf8'); });
  child.stderr.on('data', capture);
  child.once('error', cause => { failure = closedError('cloud_broker_command_failed', cause); });
  child.once('close', code => {
    clearTimeout(timer); clearTimeout(killTimer); if (activeChild === child) activeChild = undefined;
    if (authority.signal.aborted) reject(authority.signal.reason);
    else if (failure || code !== 0) reject(failure || closedError('cloud_broker_command_failed'));
    else resolve(stdout.trim());
  });
});
const checkRegistration = (value) => {
  let fd;
  try {
    fd = openSync(join(c.directory, 'registration.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const s = fstatSync(fd);
    if (!s.isFile() || s.size > 512 || (s.mode & 0o077) || s.uid !== statSync(c.directory).uid) return;
    const r = JSON.parse(readFileSync(fd, 'utf8'));
    if (keys(r, 'deviceId,tokenSha256,version,workspaceId') && r.version === 1 && r.deviceId === value.deviceId &&
        r.workspaceId === value.workspaceId && r.tokenSha256 === value.tokenSha256) resolveRegistration();
  } catch { /* Stale or partial registration is not proof. */ }
  finally { if (fd !== undefined) closeSync(fd); }
};
try {
  totalTimer = setTimeout(() => abort(closedError('cloud_broker_timeout')), c.timeoutMs);
  process.stdout.write('mikka-worker-broker-attestation ' + JSON.stringify({
    version: 1, runId: c.runId, leaseId: c.leaseId, sourceSha: c.workerSha, broker: true
  }) + '\n');
  const value = await commit;
  authority.signal.throwIfAborted();
  // Preserve the original publication's 40s budget after upload acknowledgement;
  // the pre-commit parked broker has its own equally bounded, credential-free wait.
  clearTimeout(totalTimer);
  totalTimer = setTimeout(() => abort(closedError('cloud_broker_timeout')), c.timeoutMs);
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (!uuid.test(value.deviceId) || !uuid.test(value.workspaceId) || !/^[a-f0-9]{64}$/.test(value.tokenSha256) ||
      !Array.isArray(value.files) || value.files.length !== 4) throw closedError('cloud_broker_manifest_invalid');
  const suffixes = ['', '.run', '.claude', '.codex'], limits = [4096, 1024, 65536, 65536], contents = [];
  for (let i = 0; i < suffixes.length; i++) {
    const item = value.files[i];
    if (!keys(item, 'bytes,sha256') || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > limits[i] || !/^[a-f0-9]{64}$/.test(item.sha256))
      throw closedError('cloud_broker_manifest_invalid');
    const bytes = read(c.handoff + suffixes[i], limits[i]);
    if (bytes.length !== item.bytes || createHash('sha256').update(bytes).digest('hex') !== item.sha256)
      throw closedError('cloud_broker_upload_incomplete');
    contents.push(bytes);
  }
  const bootstrap = JSON.parse(contents[0].toString('utf8')), locator = JSON.parse(contents[1].toString('utf8'));
  if (bootstrap.deviceId !== value.deviceId || bootstrap.workspaceId !== value.workspaceId || typeof bootstrap.credential !== 'string' ||
      createHash('sha256').update(bootstrap.credential).digest('hex') !== value.tokenSha256 ||
      !keys(locator, 'bootstrapSha256,runId,version') || locator.version !== 1 || locator.runId !== c.runId ||
      locator.bootstrapSha256 !== value.files[0].sha256) throw closedError('cloud_broker_bundle_mismatch');
  // Recheck the selected release after the server's existing credential transaction.
  const runtime = realpathSync(c.runtimeRoot || '/opt/mikka'), selected = realpathSync(join(runtime, 'worker'));
  if (read(join(runtime, 'worker-source-sha'), 512).toString('utf8').trim() !== c.workerSha ||
      read(join(dirname(selected), 'worker-ready.sha'), 512).toString('utf8').trim() !== c.workerSha)
    throw closedError('cloud_broker_release_changed');
  await command(c.prepare);
  watchRegistration = watch(c.directory, (_event, name) => { if (String(name) === 'registration.json') checkRegistration(value); });
  watchRegistration.on('error', cause => abort(closedError('cloud_registration_watch_failed', cause)));
  await command(c.publish);
  if (await command(c.wake) !== c.wakeReceipt) {
    const child = spawn('/bin/sh', ['-c', c.start], { detached: true, stdio: 'ignore' });
    child.once('error', cause => abort(closedError('cloud_registration_start_failed', cause)));
    child.unref();
  }
  authority.signal.throwIfAborted();
  process.stdout.write('mikka-worker-registration-wait\n');
  registrationTimer = setTimeout(() => abort(closedError('cloud_registration_timeout')), Math.min(30000, c.registrationTimeoutMs));
  checkRegistration(value);
  await registered;
  authority.signal.throwIfAborted();
  complete = true;
  process.stdout.write('mikka-worker-registered\n');
} catch (cause) {
  // Only fixed codes, never file contents, commands, credentials or native output.
  const allowed = ['cloud_broker_aborted','cloud_broker_input_invalid','cloud_broker_input_ended','cloud_broker_input_failed',
    'cloud_broker_file_invalid','cloud_broker_file_changed','cloud_broker_command_timeout','cloud_broker_command_output',
    'cloud_broker_command_failed','cloud_broker_timeout','cloud_broker_manifest_invalid','cloud_broker_upload_incomplete',
    'cloud_broker_bundle_mismatch','cloud_broker_release_changed','cloud_registration_watch_failed',
    'cloud_registration_start_failed','cloud_registration_timeout'];
  process.stderr.write((allowed.includes(cause?.code) ? cause.code : 'cloud_broker_failed') + '\n');
  process.exitCode = 1;
} finally {
  clearTimeout(totalTimer); clearTimeout(registrationTimer); clearTimeout(killTimer);
  watchRegistration?.close();
  process.stdin.off('data', onData); process.stdin.off('end', onEnd); process.stdin.off('error', onInputError); process.stdin.pause();
  process.off('SIGTERM', onSignal); process.off('SIGINT', onSignal);
  if (!complete) for (const suffix of ['', '.run', '.claude', '.codex']) {
    try { unlinkSync(c.handoff + suffix); } catch { /* The exact staging file may not have been uploaded. */ }
  }
}
`
