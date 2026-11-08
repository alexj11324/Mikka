import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { ownerViewerUrl, observeOwnerViewer } from './self-hosted-vault-viewer.mjs'

const binding = { ownerId: 'owned', workspaceId: 'workspace', botId: 'bot', subagentId: 'browser' }
const now = 1_800_000_000_000
const capability = (change = {}) => {
  const claim = { ...binding, role: 'view', exp: now / 1000 + 120, ...change }
  const token = Buffer.from(JSON.stringify(claim)).toString('base64url') + '.synthetic_signature'
  return { url: `wss://owned.example.test/agents/browser/viewer?token=${token}`, expiresAt: new Date(claim.exp * 1000).toISOString() }
}
test('owner viewer uses only the ordinary API capability with the exact scope, role and finite expiry', () => {
  assert.equal(ownerViewerUrl(capability(), binding, now), capability().url)
  for (const changed of [{ ownerId: 'foreign' }, { workspaceId: 'foreign' }, { botId: 'foreign' },
    { subagentId: 'foreign' }, { role: 'runtime' }, { role: 'broker' }, { exp: now / 1000 }, { exp: now / 1000 + 300 }]) {
    assert.throws(() => ownerViewerUrl(capability(changed), binding, now), /VIEWER_BINDING/)
  }
  for (const url of [capability().url.replace('wss:', 'ws:'), capability().url.replace('/viewer?', '/action?'),
    capability().url + '&other=1']) assert.throws(() => ownerViewerUrl({ ...capability(), url }, binding, now), /VIEWER_CAPABILITY/)
})

const frames = await Promise.all(['white', 'black'].map(background =>
  sharp({ create: { width: 32, height: 32, channels: 3, background } }).jpeg().toBuffer()))
class FixtureSocket extends EventTarget {
  static all = []
  readyState = 0
  constructor() { super(); FixtureSocket.all.push(this) }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  pong() { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'pong' }) })) }
  frame(value = 1) {
    const bytes = frames[value - 1]
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'frame', data: bytes.toString('base64') }) }))
  }
  remoteClose(wasClean = true) {
    this.readyState = 3
    this.dispatchEvent(Object.assign(new Event('close'), { wasClean, code: wasClean ? 1000 : 1006 }))
  }
  close() { queueMicrotask(() => this.remoteClose()) }
}
async function atGuard() {
  FixtureSocket.all = []
  const viewer = observeOwnerViewer('wss://synthetic.example.test', FixtureSocket)
  const first = FixtureSocket.all[0]
  first.open(); first.frame()
  await viewer.beforeLogin()
  first.remoteClose()
  const second = FixtureSocket.all[1]
  second.open()
  return { viewer, first, second }
}

test('evidence requires positive, clean guard closure, a live silent interval and a new frame on the same connection', async () => {
  const { viewer, second } = await atGuard()
  try {
    second.pong()
    const observation = await viewer.whileFormHeld(performance.now())
    assert.equal(observation.frames, 0)
    assert.ok(observation.observedForMs >= 700)
    assert.ok(observation.postToObservationMs >= 0)
    viewer.allowSafeNavigation()
    second.pong()
    second.frame(2)
    assert.deepEqual(await viewer.afterSafeNavigation(), { ownerViewerBeforeLogin: true, guardedViewerClosed: true,
      filledFormEmittedNoFrames: true, ownerViewerAfterSafeNavigation: true })
    assert.equal(FixtureSocket.all.length, 2)
  } finally { await viewer.close() }
  assert.ok(FixtureSocket.all.every(socket => socket.readyState === 3))
})
test('even one image while the filled form is held rejects the acceptance', async () => {
  const { viewer, second } = await atGuard()
  try {
    second.frame(2)
    await assert.rejects(viewer.whileFormHeld(performance.now()), /VIEWER_GUARD_LEAK/)
  } finally { await viewer.close() }
})
test('a disconnected viewer cannot count as a protected silent interval', async () => {
  const { viewer, second } = await atGuard()
  try {
    second.remoteClose(false)
    await assert.rejects(viewer.whileFormHeld(performance.now()), /VIEWER_(CLOSED_UNEXPECTEDLY|GUARD_STATE)/)
  } finally { await viewer.close() }
})
test('replaying the old image cannot count as recovery after navigation', async () => {
  const { viewer, second } = await atGuard()
  try {
    await viewer.whileFormHeld(performance.now())
    viewer.allowSafeNavigation()
    second.frame(1)
    await assert.rejects(viewer.afterSafeNavigation(), /VIEWER_RECOVERY_STALE/)
  } finally { await viewer.close() }
})
test('the silence timer cannot start before a real POST timestamp and an OPEN replacement connection', async () => {
  const { viewer, second } = await atGuard()
  try {
    await assert.rejects(viewer.whileFormHeld(undefined), /VIEWER_POST_NOT_RECEIVED/)
    await assert.rejects(viewer.whileFormHeld(performance.now() + 60_000), /VIEWER_POST_NOT_RECEIVED/)
    second.readyState = 2
    await assert.rejects(viewer.whileFormHeld(performance.now()), /VIEWER_GUARD_STATE/)
  } finally { await viewer.close() }
})
test('non-image messages cannot satisfy either image positive control', async () => {
  FixtureSocket.all = []
  const viewer = observeOwnerViewer('wss://synthetic.example.test', FixtureSocket)
  try {
    const first = FixtureSocket.all[0]
    first.open()
    let initialPassed = false
    const initial = viewer.beforeLogin().then(() => { initialPassed = true })
    first.pong()
    await new Promise(setImmediate)
    assert.equal(initialPassed, false)
    first.frame(); await initial
    first.remoteClose()
    const second = FixtureSocket.all[1]
    second.open(); second.pong()
    await viewer.whileFormHeld(performance.now())
    viewer.allowSafeNavigation()
    let recovered = false
    const recovery = viewer.afterSafeNavigation().then(() => { recovered = true })
    second.pong()
    await new Promise(setImmediate)
    assert.equal(recovered, false)
    second.frame(2); await recovery
  } finally { await viewer.close() }
})
test('JPEG markers without a decodable image cannot pass the initial positive control', async () => {
  FixtureSocket.all = []
  const viewer = observeOwnerViewer('wss://synthetic.example.test', FixtureSocket)
  try {
    const first = FixtureSocket.all[0]
    first.open()
    const invalid = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(256), Buffer.from([0xff, 0xd9])])
    first.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'frame', data: invalid.toString('base64') }) }))
    await assert.rejects(viewer.beforeLogin(), /VIEWER_FRAME_FORMAT/)
  } finally { await viewer.close() }
})
