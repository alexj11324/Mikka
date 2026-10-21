import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { getCookies } from 'better-auth/cookies'

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
  assert.match(source, /await document\.requestStorageAccess\(\)/)
  assert.match(source, /target="_blank" rel="noopener noreferrer"/)
  assert.doesNotMatch(source, /localStorage|document\.cookie\s*=/)
})
