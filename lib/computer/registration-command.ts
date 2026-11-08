/** A single existing provider command publishes and starts/wakes the worker.
 * A capable release waits for its registration event; legacy releases retain
 * the database readiness gate. No credential bytes enter argv or environment. */
export const REGISTRATION_WAITING = 'mikka-worker-registration-wait'
export const REGISTRATION_LEGACY = 'mikka-worker-registration-legacy'
export const REGISTRATION_COMPLETE = 'mikka-worker-registered'

export type RegistrationCommand = {
  directory: string
  deviceId: string
  workspaceId: string
  tokenSha256: string
  publish: string
  wake: string
  wakeReceipt: string
  start: string
  timeoutMs: number
  workerSha: string
  runtimeRoot?: string
}

export const REGISTRATION_SCRIPT = String.raw`
import { constants, openSync, closeSync, fstatSync, readFileSync, realpathSync, lstatSync, statSync, watch } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
const c = JSON.parse(process.argv[1]);
const noticeSupported = () => {
  let fd;
  const trusted = path => {
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const s = fstatSync(fd);
      if (!s.isFile() || s.size > 512 || s.uid !== process.getuid() || (s.mode & 0o022)) throw new Error('untrusted');
      return readFileSync(fd, 'utf8');
    } finally { if (fd !== undefined) { closeSync(fd); fd = undefined; } }
  };
  try {
    const runtime = realpathSync(c.runtimeRoot || '/opt/mikka');
    const link = join(runtime, 'worker'), ls = lstatSync(link);
    const source = realpathSync(link), release = dirname(source);
    if (!ls.isSymbolicLink() || ls.uid !== process.getuid() ||
        basename(source) !== 'source' || dirname(release) !== join(runtime, 'releases') ||
        !/^[a-f0-9]{40}$/.test(basename(release))) return false;
    for (const path of [release, source]) {
      const s = lstatSync(path);
      if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o022)) return false;
    }
    const path = join(source, 'packages/daemon/dist/cloud/runtime-capabilities.json');
    if (realpathSync(path) !== path) return false;
    const capability = JSON.parse(trusted(path));
    return Object.keys(capability).sort().join(',') === 'registrationNoticeVersion,workerSha' &&
      capability.registrationNoticeVersion === 1 && capability.workerSha === c.workerSha &&
      trusted(join(runtime, 'worker-source-sha')).trim() === c.workerSha &&
      trusted(join(release, 'worker-ready.sha')).trim() === c.workerSha;
  } catch { return false; }
};
const supportsNotice = noticeSupported();
let watcher, timer, done = false, resolve, reject;
const ready = new Promise((yes, no) => { resolve = yes; reject = no; });
void ready.catch(() => {});
const finish = error => { if (done) return; done = true; error ? reject(error) : resolve(); };
const check = () => {
  let fd;
  try {
    fd = openSync(join(c.directory, 'registration.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const s = fstatSync(fd);
    if (!s.isFile() || s.size > 512 || (s.mode & 0o077) || s.uid !== statSync(c.directory).uid) return;
    const r = JSON.parse(readFileSync(fd, 'utf8'));
    if (Object.keys(r).sort().join(',') !== 'deviceId,tokenSha256,version,workspaceId') return;
    if (r.version === 1 && r.deviceId === c.deviceId && r.workspaceId === c.workspaceId && r.tokenSha256 === c.tokenSha256) finish();
  } catch { /* Missing, partial, stale and invalid notifications cannot authorize readiness. */ }
  finally { if (fd !== undefined) closeSync(fd); }
};
const command = source => {
  const r = spawnSync('/bin/sh', ['-c', source], { encoding: 'utf8', timeout: 10000, maxBuffer: 4096 });
  if (r.error || r.status !== 0) throw new Error('cloud_registration_publish_failed', { cause: r.error });
  return r.stdout.trim();
};
try {
  if (supportsNotice) {
    watcher = watch(c.directory, (_event, name) => { if (String(name) === 'registration.json') check(); });
    watcher.on('error', error => finish(new Error('cloud_registration_watch_failed', { cause: error })));
  }
  command(c.publish);
  if (command(c.wake) !== c.wakeReceipt) {
    const child = spawn('/bin/sh', ['-c', c.start], { detached: true, stdio: 'ignore' });
    child.once('error', error => finish(new Error('cloud_registration_start_failed', { cause: error })));
    child.unref();
  }
  if (!supportsNotice) process.stdout.write('mikka-worker-registration-legacy\n');
  else {
    process.stdout.write('mikka-worker-registration-wait\n');
    timer = setTimeout(() => finish(new Error('cloud_registration_timeout')), c.timeoutMs);
    check();
    await ready;
    process.stdout.write('mikka-worker-registered\n');
  }
} catch (error) {
  const code = error?.message;
  process.stderr.write(['cloud_registration_publish_failed','cloud_registration_watch_failed','cloud_registration_start_failed','cloud_registration_timeout'].includes(code) ? code + '\n' : 'cloud_registration_failed\n');
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  watcher?.close();
}
`

export const quoteShell = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"

export function registrationCommand(config: RegistrationCommand) {
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs > 30_000 ||
    !/^[a-f0-9]{64}$/.test(config.tokenSha256) || !/^[a-f0-9]{40}$/.test(config.workerSha)) throw new Error('Invalid worker registration wait')
  return '/opt/mikka/runtime/node/bin/node --input-type=module -e ' +
    quoteShell(REGISTRATION_SCRIPT) + ' ' + quoteShell(JSON.stringify(config))
}
