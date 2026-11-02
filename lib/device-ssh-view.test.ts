import assert from 'node:assert/strict'
import test from 'node:test'
import { LOCAL_RECONNECT, LOCAL_TARGET, type SshInstallState } from '@mikka/protocol/bridge'
import { STEPS, addedHost, isLocal, stepStates, visibleSteps } from './device-ssh-view'

const state = (step: SshInstallState['step'], status: SshInstallState['status']): SshInstallState => ({ id: 'i', target: 'build-02', step, status })

test('the installer\'s five steps fold into the four Figma shows', () => {
  assert.deepEqual(stepStates(state('login', 'running')), { connect: 'running', install: 'pending', start: 'pending', online: 'pending' })
  assert.deepEqual(stepStates(state('check', 'running')), { connect: 'running', install: 'pending', start: 'pending', online: 'pending' })
  assert.deepEqual(stepStates(state('service', 'running')), { connect: 'done', install: 'done', start: 'running', online: 'pending' })
  assert.deepEqual(stepStates(state('connect', 'running')), { connect: 'done', install: 'done', start: 'done', online: 'running' })
})

test('a failure marks only its own step and keeps the rest waiting', () => {
  assert.deepEqual(stepStates(state('install', 'failed')), { connect: 'done', install: 'failed', start: 'pending', online: 'pending' })
})

test('online completes every step', () => {
  assert.deepEqual(stepStates(state('connect', 'online')), { connect: 'done', install: 'done', start: 'done', online: 'done' })
})

test('an ssh alias counts as added by device name or host name', () => {
  const devices = [{ name: 'build-01', hostname: null }, { name: 'Dev box', hostname: 'staging.aspectly.dev' }]
  assert.equal(addedHost('build-01', devices), true)
  assert.equal(addedHost('BUILD-01', devices), true)
  assert.equal(addedHost('staging', devices), true)
  assert.equal(addedHost('build-02', devices), false)
})

test('添加这台电脑 shows 安装 → 启动 → 已上线, with the node check counted as installing', () => {
  const state = { id: 'l', target: LOCAL_TARGET, step: 'check', status: 'running' } as const
  assert.deepEqual(visibleSteps(state), ['install', 'start', 'online'])
  assert.equal(stepStates(state).install, 'running')
  assert.equal(stepStates({ ...state, step: 'service' }).install, 'done')
})

test('重新连接 this computer shows 启动 → 已上线; SSH keeps all four steps', () => {
  assert.deepEqual(visibleSteps({ target: LOCAL_RECONNECT }), ['start', 'online'])
  assert.equal(stepStates({ id: 'r', target: LOCAL_RECONNECT, step: 'service', status: 'failed', reason: 'x' }).start, 'failed')
  assert.deepEqual(visibleSteps({ target: 'deploy@build-01' }), STEPS)
  assert.equal(isLocal({ target: 'deploy@build-01' }), false)
})
