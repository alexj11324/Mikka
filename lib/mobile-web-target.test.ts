import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mobileWebTarget } from './mobile-web-target'

const BOT = '12345678-1234-1234-1234-123456789abc'

test('the app may open the Coordinator chat, a bot chat, a task or Settings', () => {
  assert.equal(mobileWebTarget('/?section=coordinator'), '/?section=coordinator')
  assert.equal(mobileWebTarget(`/?section=coordinator&bot=${BOT.toUpperCase()}`), `/?section=coordinator&bot=${BOT}`)
  assert.equal(mobileWebTarget(`/?section=coordinator&workspace=${BOT.toUpperCase()}`), `/?section=coordinator&workspace=${BOT}`)
  assert.equal(mobileWebTarget(`/?section=coordinator&bot=${BOT}&workspace=${BOT}`), `/?section=coordinator&bot=${BOT}&workspace=${BOT}`)
  assert.equal(mobileWebTarget(`/?issue=${BOT}`), `/?issue=${BOT}`)
  assert.equal(mobileWebTarget('/settings'), '/settings')
  assert.equal(mobileWebTarget('/settings?section=computers'), '/settings?section=computers')
  assert.equal(mobileWebTarget('/settings?section=models'), '/settings?section=models')
  assert.equal(mobileWebTarget('/settings?section=billing'), '/settings?section=billing')
  assert.equal(mobileWebTarget(`/settings?section=billing&workspace=${BOT.toUpperCase()}`), `/settings?section=billing&workspace=${BOT}`)
  assert.equal(mobileWebTarget(`/settings?section=models&workspace=${BOT}`), `/settings?section=models&workspace=${BOT}`)
  assert.equal(mobileWebTarget('/?section=plugins'), '/?section=plugins')
  assert.equal(mobileWebTarget('/?section=plugins&app=gmail'), '/?section=plugins&app=gmail')
  assert.equal(mobileWebTarget(`/api/artifacts/${BOT.toUpperCase()}/versions/3/frame`), `/api/artifacts/${BOT}/versions/3/frame`)
})

test('settings recovery only accepts one validated workspace and an allowed section', () => {
  for (const value of ['/settings?section=billing&workspace=evil', `/settings?section=members&workspace=${BOT}`, `/settings?section=models&workspace=${BOT}&next=//evil.dev`, `/settings?section=models&workspace=${BOT}&workspace=${BOT}`, '/settings?section=models&workspace=', '/settings?section=models&section=billing']) assert.equal(mobileWebTarget(value), '/', value)
})

test('scoped chats reject malformed, extra and repeated authority parameters', () => {
  for (const value of ['/?section=coordinator&workspace=private', `/?section=coordinator&workspace=${BOT}&workspace=${BOT}`, `/?section=coordinator&bot=${BOT}&workspace=${BOT}&owner=other`, `/?section=coordinator&bot=${BOT}&bot=${BOT}`, `/?section=coordinator&workspace=${BOT}#fragment`]) assert.equal(mobileWebTarget(value), '/', value)
})

test('anything else is the home page', () => {
  for (const value of [null, '', 'https://evil.dev', '//evil.dev', '/api/auth/sign-out', '/settings?next=//evil.dev', '/settings?section=members', '/settings?section=models&x=1', '/settings?section=computers#x', '/?section=plugins&app=Gmail', '/?section=plugins&app=../x', '/?section=plugins&app=gmail&x=1', '/?section=plugins#x', '/settings/members', '/settings#x', '/?section=coordinator&bot=nope', `/?section=coordinator&bot=${BOT}&x=1`, '/?section=coordinator#x', '/\\evil.dev', `/api/artifacts/${BOT}/versions/3/download`, `/api/artifacts/${BOT}/versions/0/frame`, `/api/artifacts/${BOT}/versions/3/frame?x=1`, '/api/artifacts/nope/versions/1/frame']) {
    assert.equal(mobileWebTarget(value), '/', String(value))
  }
})

test('the native Task rendezvous is HTTPS, bounded, keeps the physical URL entity-free, and retires on account change', async () => {
  const { mobileTaskLaunch, mobileTaskTarget } = await import('./mobile-task-handoff')
  const { showMobileTaskLocation, mobileTaskLocation } = await import('./web-connection/mobile-task-location')
  const { installWebSelection } = await import('./web-connection/selection')
  let version = 0
  installWebSelection(() => ({ version, account: null }))
  const ref = 'A'.repeat(43)
  const origin = 'https://official.example/mikka'
  const launch = new URL(origin)
  launch.hash = new URLSearchParams({ mobileTask: ref, server: 'https://self.example/mikka' }).toString()
  assert.deepEqual(mobileTaskLaunch(launch), { ref, server: 'https://self.example/mikka' })
  assert.equal(mobileTaskTarget('https://wrong.example/?issue=' + BOT), null)
  assert.equal(mobileTaskTarget('/?issue=' + BOT + '&token=outside'), null)
  for (const fragment of [
    new URLSearchParams({ mobileTask: 'short', server: 'https://self.example' }),
    new URLSearchParams({ mobileTask: ref, server: 'http://self.example' }),
    new URLSearchParams({ mobileTask: ref, server: 'https://self.example', issue: BOT }),
  ]) assert.equal(mobileTaskLaunch(new URL(origin + '#' + fragment)), null)
  const params = new URLSearchParams({ issue: BOT, workspace: BOT })
  await showMobileTaskLocation(launch.href, params, async () => ({ ok: true }), () => true)
  assert.equal(launch.search, '')
  assert.equal(new URL(mobileTaskLocation(launch.href)).searchParams.get('issue'), BOT)
  assert.equal(mobileTaskLocation('https://elsewhere.example'), 'https://elsewhere.example')
  version++
  assert.equal(mobileTaskLocation(launch.href), launch.href)
})

test('restoring a saved handoff only resumes the currently selected server and account', async () => {
  const { canResumeMobileTask } = await import('./web-connection/mobile-task-location')
  const server = 'https://self.example/mikka'
  const self = { server, user: { id: 'reader' } }
  assert.ok(canResumeMobileTask(server, false, 'reader', { account: self, expiredServer: null }))
  assert.ok(canResumeMobileTask('https://official.example/mikka', true, 'reader', { account: null, expiredServer: null }))
  assert.equal(canResumeMobileTask('https://official.example/mikka', true, 'reader', { account: self, expiredServer: null }), false)
  assert.equal(canResumeMobileTask(server, false, 'other', { account: self, expiredServer: null }), false)
  assert.equal(canResumeMobileTask('https://other.example', false, 'reader', { account: self, expiredServer: null }), false)
  assert.equal(canResumeMobileTask(server, true, 'reader', { account: null, expiredServer: server }), false)
})

test('the authorized source workspace must be selected before rendering its Task', async () => {
  const { showMobileTaskLocation, mobileTaskLocation } = await import('./web-connection/mobile-task-location')
  const document = 'https://official.example/#mobileTask=workspace'
  const query = new URLSearchParams({ issue: BOT, workspace: BOT })
  let active = true
  let allow = false
  const selected: string[] = []
  const select = async (id: string) => { selected.push(id); return { ok: allow } }
  assert.equal(await showMobileTaskLocation(document, query, select, () => active), false)
  assert.equal(mobileTaskLocation(document), document)
  allow = true
  assert.equal(await showMobileTaskLocation(document, query, async id => {
    active = false
    return select(id)
  }, () => active), false)
  assert.equal(mobileTaskLocation(document), document)
  active = true
  assert.equal(await showMobileTaskLocation(document, query, select, () => active), true)
  assert.deepEqual(selected, [BOT, BOT, BOT])
  assert.equal(new URL(mobileTaskLocation(document)).searchParams.get('issue'), BOT)
})
