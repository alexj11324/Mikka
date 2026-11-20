import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, writeFile, readFile, realpath, readlink, chown, rm, lstat, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

/** Optional execution backend for the HTTP fake. Each fake VM owns a real
 * Linux mount/PID namespace and files; no host home, credentials or environment
 * enter it. The ordinary SDK remains the only caller of this backend. */
export async function createLocalE2BProcesses({ env = {}, mounts = [], networkAdministration = false, prepare = async () => {} } = {}) {
  assert.equal(process.platform, 'linux', 'LOCAL_E2B_PROCESS_REQUIRES_LINUX')
  const directory = await mkdtemp(join(tmpdir(), 'mikka-http-e2b-'))
  const userUid = process.getuid() === 0 ? 1000 : process.getuid(), userGid = process.getuid() === 0 ? 1000 : process.getgid()
  const instances = new Map()
  const bridge = fileURLToPath(new URL('./e2b-process-bridge.mjs', import.meta.url))
  let sequence = 0
  async function create(sandbox) {
    assert.match(sandbox.id, /^local-sandbox-\d+$/)
    const root = join(directory, sandbox.id)
    for (const path of ['home/user', 'root', 'run', 'tmp', 'etc/pam.d', 'opt/mikka']) await mkdir(join(root, path), { recursive: true, mode: 0o755 })
    await chown(join(root, 'home/user'), userUid, userGid)
    await writeFile(join(root, 'etc/passwd'), `root:x:0:0:root:/root:/bin/bash\nuser:x:${userUid}:${userGid}:user:/home/user:/bin/bash\n`)
    await writeFile(join(root, 'etc/group'), `root:x:0:\nuser:x:${userGid}:\n`)
    await writeFile(join(root, 'etc/nsswitch.conf'), 'passwd: files\ngroup: files\nhosts: files\n')
    await writeFile(join(root, 'etc/hosts'), '127.0.0.1 localhost\n::1 localhost\n')
    await writeFile(join(root, 'etc/pam.d/runuser'), 'auth sufficient pam_permit.so\naccount sufficient pam_permit.so\nsession sufficient pam_permit.so\n')
    await prepare({ sandbox, root })
    const capabilities = ['SETUID', 'SETGID', 'CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'KILL']
    if (networkAdministration) {
      assert.equal(process.getuid(), 0, 'LOCAL_E2B_ROOT_IDENTITY_UNAVAILABLE')
      assert.notEqual(await readlink('/proc/self/ns/net'), await readlink('/proc/1/ns/net'), 'LOCAL_E2B_NETWORK_NAMESPACE_NOT_ISOLATED')
      capabilities.push('NET_ADMIN')
    }
    const args = ['--die-with-parent', '--new-session', '--unshare-pid', ...capabilities.flatMap(name => ['--cap-add', `CAP_${name}`]), '--bind', root, '/', '--proc', '/proc', '--dev', '/dev']
    for (const path of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc/ssl/certs']) args.push('--ro-bind-try', path, path)
    args.push('--ro-bind', dirname(dirname(process.execPath)), dirname(dirname(process.execPath)), '--ro-bind', bridge, '/bridge.mjs')
    for (const mount of typeof mounts === 'function' ? await mounts({ sandbox, root }) : mounts) {
      assert.ok(mount.source && mount.target.startsWith('/') && !['/', '/root', '/home', '/etc', '/run'].includes(mount.target), 'LOCAL_E2B_MOUNT_INVALID')
      args.push('--ro-bind', resolve(mount.source), mount.target)
    }
    args.push('--chdir', '/home/user', '--', process.execPath, '/bridge.mjs', String(userUid), String(userGid))
    const child = spawn('/usr/bin/bwrap', args, { env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C.UTF-8', ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    const jobs = new Map(), pending = new Map(), lines = createInterface({ input: child.stdout })
    // Only fixed diagnostics leave this boundary; bwrap errors may contain paths.
    child.stderr.resume()
    const ready = new Promise((yes, no) => {
      const timeout = setTimeout(() => no(Error('LOCAL_E2B_NAMESPACE_NOT_READY')), 10_000)
      child.once('error', cause => { clearTimeout(timeout); no(Error('LOCAL_E2B_NAMESPACE_UNAVAILABLE', { cause })) })
      child.once('exit', () => { clearTimeout(timeout); no(Error('LOCAL_E2B_NAMESPACE_EXITED')) })
      lines.on('line', line => {
        const event = JSON.parse(line)
        if (event.type === 'ready') { clearTimeout(timeout); yes(); return }
        const job = pending.get(event.id)
        if (!job) return
        if (event.type === 'start') { job.pid = event.pid; jobs.set(event.pid, job); job.started() }
        else if (event.type === 'end') { job.exited = event.exitCode; jobs.delete(job.pid) }
        job.events.push(event); job.emit('event', event)
      })
    })
    const instance = { root, child, jobs, pending, send: value => child.stdin.write(`${JSON.stringify(value)}\n`) }
    instances.set(sandbox.id, instance)
    child.once('close', () => {
      for (const job of pending.values()) if (job.exited === undefined) {
        job.exited = 128; job.started(); job.emit('event', { type: 'end', exitCode: 128 })
      }
    })
    await ready
    return instance
  }
  const instanceFor = async sandbox => instances.get(sandbox.id) ?? await create(sandbox)
  async function pathFor(sandbox, path, writing = false) {
    assert.ok(path.startsWith('/') && !path.includes('\0'), 'LOCAL_E2B_FILE_PATH_INVALID')
    const { root } = await instanceFor(sandbox), target = resolve(root, `.${path}`)
    assert.ok(target.startsWith(`${root}/`), 'LOCAL_E2B_FILE_PATH_ESCAPE')
    if (writing) {
      let current = root
      for (const name of dirname(target).slice(root.length + 1).split('/').filter(Boolean)) {
        current = join(current, name)
        try { await mkdir(current, { mode: 0o755 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
        const info = await lstat(current)
        assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'LOCAL_E2B_FILE_SYMLINK_ESCAPE')
      }
    }
    const parent = await realpath(writing ? dirname(target) : target)
    assert.ok(parent.startsWith(`${root}/`), 'LOCAL_E2B_FILE_SYMLINK_ESCAPE')
    return target
  }
  async function kill(sandbox) {
    const instance = instances.get(sandbox.id)
    if (!instance) return
    instances.delete(sandbox.id)
    if (instance.child.exitCode === null) {
      instance.child.kill('SIGKILL')
      await new Promise(resolve => instance.child.once('close', resolve))
    }
  }
  return {
    create, async read(sandbox, path) { return readFile(await pathFor(sandbox, path)) },
    async write(sandbox, path, bytes, user = 'user') {
      assert.ok(user !== 'root' || process.getuid() === 0, 'LOCAL_E2B_ROOT_IDENTITY_UNAVAILABLE')
      const target = await pathFor(sandbox, path, true), file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600)
      try { await file.writeFile(bytes); if (user === 'user') await file.chown(userUid, userGid) } finally { await file.close() }
    },
    async start(sandbox, process, { stdin, user }) {
      assert.ok(user !== 'root' || globalThis.process.getuid() === 0, 'LOCAL_E2B_ROOT_IDENTITY_UNAVAILABLE')
      const instance = await instanceFor(sandbox), job = Object.assign(new EventEmitter(), { pid: 0, events: [], exited: undefined, started: () => {} })
      const started = new Promise(resolve => { job.started = resolve })
      const id = ++sequence
      instance.pending.set(id, job)
      instance.send({ op: 'start', id, process, stdin, user })
      await started
      return job
    },
    async process(sandbox, pid) { return (await instanceFor(sandbox)).jobs.get(pid) },
    async input(sandbox, pid, bytes) { const instance = await instanceFor(sandbox); assert.ok(instance.jobs.has(pid), 'LOCAL_E2B_PROCESS_NOT_FOUND'); instance.send({ op: 'input', pid, data: bytes.toString('base64') }) },
    async closeInput(sandbox, pid) { (await instanceFor(sandbox)).send({ op: 'close-input', pid }) },
    async signal(sandbox, pid, signal = 9) { const instance = await instanceFor(sandbox); assert.ok(instance.jobs.has(pid), 'LOCAL_E2B_PROCESS_NOT_FOUND'); instance.send({ op: 'signal', pid, signal }) },
    kill, async close() { await Promise.all([...instances.keys()].map(id => kill({ id }))); await rm(directory, { recursive: true, force: true }) },
  }
}
