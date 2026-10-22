import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { getCookies } from 'better-auth/cookies'
import { recoverAcceptanceSession } from '../lib/acceptance-recovery.ts'

test('预览分区 Cookie 保持 HttpOnly、Secure 和 SameSite=None', async () => {
  const source = await readFile(new URL('../lib/auth.ts', import.meta.url), 'utf8')
  assert.match(source, /process\.env\.NODE_ENV === 'development' \? \{ advanced:/)
  assert.match(source, /defaultCookieAttributes: \{ sameSite: 'none' as const, secure: true, partitioned: true \}/)
  const { sessionToken } = getCookies({
    baseURL: 'https://preview.example.com',
    advanced: { defaultCookieAttributes: { sameSite: 'none', secure: true, partitioned: true } },
  })
  assert.equal(sessionToken.attributes.partitioned, true)
  assert.equal(sessionToken.attributes.secure, true)
  assert.equal(sessionToken.attributes.sameSite, 'none')
  assert.equal(sessionToken.attributes.httpOnly, true)
  assert.equal(sessionToken.attributes.path, '/')
  assert.equal(getCookies({ baseURL: 'https://app.example.com' }).sessionToken.attributes.partitioned, undefined)
})

test('验收恢复需要用户授权，且不改用不安全的客户端会话', async () => {
  const source = await readFile(new URL('../components/acceptance-entry.tsx', import.meta.url), 'utf8')
  assert.match(source, /onClick=\{recoverSession\}/)
  assert.match(source, /\(\) => document\.requestStorageAccess\(\)/)
  assert.match(source, /target="_blank" rel="noopener noreferrer"/)
  assert.ok(source.indexOf("t('openNewTab')") < source.indexOf("t('allowAndRetry')"))
  assert.doesNotMatch(source, /hasStorageAccess|window\.open|localStorage|document\.cookie\s*=/)
})

test('Safari 授权必须在点击调用栈内发生，授权完成后才导航', async () => {
  const events = []
  let grant
  const pending = recoverAcceptanceSession({
    embedded: true,
    requestStorageAccess: () => {
      events.push('request')
      return new Promise(resolve => { grant = resolve })
    },
    navigate: () => events.push('navigate'),
  })
  assert.deepEqual(events, ['request'])
  grant()
  await pending
  assert.deepEqual(events, ['request', 'navigate'])
})

test('Safari 拒绝授权时不重定向、不再次创建访客会话', async () => {
  let navigated = false
  await assert.rejects(recoverAcceptanceSession({
    embedded: true,
    requestStorageAccess: () => Promise.reject(new Error('NotAllowedError')),
    navigate: () => { navigated = true },
  }), /NotAllowedError/)
  assert.equal(navigated, false)
})

test('不支持 Storage Access 的内嵌浏览器应使用独立入口而不是重复失败', async () => {
  let navigated = false
  await assert.rejects(recoverAcceptanceSession({
    embedded: true,
    navigate: () => { navigated = true },
  }), /Storage access is unavailable/)
  assert.equal(navigated, false)
})

test('独立标签页直接建立第一方会话，无需第三方授权', async () => {
  const events = []
  await recoverAcceptanceSession({
    embedded: false,
    requestStorageAccess: () => { throw new Error('Must not request third-party access') },
    navigate: () => events.push('navigate'),
  })
  assert.deepEqual(events, ['navigate'])
})
