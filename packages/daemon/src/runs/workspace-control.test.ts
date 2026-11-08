import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireCloudWorkspaceControl, type WorkspaceControl } from './workspace-control'

const execute = promisify(execFile)
const roots: string[] = [], controls: WorkspaceControl[] = []
afterEach(async () => {
  for (const control of controls.splice(0)) await control.release(false)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mikka-execution-fence-')); roots.push(root)
  await chmod(root, 0o710)
  for (const [name, value, mode] of [['version', '1\n', 0o440], ['machine.lock', '', 0o660], ['machine.json', '{}', 0o660]] as const)
    await writeFile(join(root, name), value, { mode })
  const input = { runId: randomUUID(), deviceId: randomUUID(), signal: new AbortController().signal, onLost: vi.fn() }
  const worktree = join(root, 'worktree'); await mkdir(worktree)
  return { root, input, worktree }
}
async function held(root: string) {
  try {
    await execute('python3', ['-I', '-c', 'import fcntl,os,sys;f=os.open(sys.argv[1],os.O_RDWR);fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)', join(root, 'machine.lock')])
    return false
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 1) return true
    throw error
  }
}

describe.runIf(process.getuid?.() === 0)('actual fixed-inode cloud execution fence', () => {
  it('holds a kernel flock through native work and records idle only after confirmed exit', async () => {
    const f = await fixture(), control = await acquireCloudWorkspaceControl(f.input, f.root); controls.push(control)
    expect(await held(f.root)).toBe(true)
    expect(JSON.parse(await readFile(join(f.root, 'machine.json'), 'utf8'))).toMatchObject({ runId: f.input.runId, deviceId: f.input.deviceId, phase: 'active', nativeExited: false })
    control.setWorktree(f.worktree)
    await control.release(true)
    expect(await held(f.root)).toBe(false)
    expect(JSON.parse(await readFile(join(f.root, 'machine.json'), 'utf8'))).toMatchObject({ phase: 'idle', nativeExited: true, worktreePath: f.worktree })
    expect(f.input.onLost).not.toHaveBeenCalled()
  })

  it('an aborted contender cannot steal control, and an unconfirmed exit remains unsafe', async () => {
    const f = await fixture(), control = await acquireCloudWorkspaceControl(f.input, f.root); controls.push(control)
    const abort = new AbortController(), other = { ...f.input, runId: randomUUID(), signal: abort.signal }
    const waiting = acquireCloudWorkspaceControl(other, f.root)
    const refused = expect(waiting).rejects.toMatchObject({ code: 'terminal_control_unavailable' })
    abort.abort(); await refused
    expect(await held(f.root)).toBe(true)
    control.setWorktree(f.worktree); await control.release(false)
    expect(JSON.parse(await readFile(join(f.root, 'machine.json'), 'utf8'))).toMatchObject({ phase: 'unsafe', nativeExited: false })
  })

  it('rejects a writable parent and substituted marker before publishing an idle receipt', async () => {
    const f = await fixture()
    await chmod(f.root, 0o777)
    await expect(acquireCloudWorkspaceControl(f.input, f.root)).rejects.toMatchObject({ code: 'terminal_control_unavailable' })
    await chmod(f.root, 0o710)
    await rm(join(f.root, 'version'))
    await writeFile(join(f.root, 'replacement'), '1\n')
    await symlink(join(f.root, 'replacement'), join(f.root, 'version'))
    await expect(acquireCloudWorkspaceControl(f.input, f.root)).rejects.toMatchObject({ code: 'terminal_control_unavailable' })
    expect(JSON.parse(await readFile(join(f.root, 'machine.json'), 'utf8'))).toEqual({})
  })
})
