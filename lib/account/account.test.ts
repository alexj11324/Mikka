import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeUserAgent } from './user-agent'
import { AVATAR_MAX_BYTES, UPLOADED_AVATAR_PATH, avatarPath, checkAvatarFile, sniffAvatarType } from './avatar-file'
import { avatarImageSrc } from '../default-avatar'

const UA = {
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  chromeIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1',
  edgeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  ipadSafari: 'Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  mikkaApp: 'Mikka/12 CFNetwork/1568.100.1 Darwin/24.0.0',
  expoGo: 'Expo/2.32.17 CFNetwork/1568.100.1 Darwin/24.0.0',
}

test('a session\'s User-Agent reads as 「浏览器 · 系统」, the iOS app as Mikka · iPhone', () => {
  assert.equal(describeUserAgent(UA.chromeMac).label, 'Chrome · macOS')
  assert.equal(describeUserAgent(UA.safariMac).label, 'Safari · macOS')
  assert.equal(describeUserAgent(UA.safariIphone).label, 'Safari · iPhone')
  assert.equal(describeUserAgent(UA.chromeIphone).label, 'Chrome · iPhone')
  assert.equal(describeUserAgent(UA.edgeWindows).label, 'Edge · Windows')
  assert.equal(describeUserAgent(UA.firefoxLinux).label, 'Firefox · Linux')
  assert.equal(describeUserAgent(UA.chromeAndroid).label, 'Chrome · Android')
  assert.equal(describeUserAgent(UA.ipadSafari).label, 'Safari · iPad')
  assert.deepEqual(describeUserAgent(UA.mikkaApp), { client: 'Mikka', os: 'iPhone', label: 'Mikka · iPhone', app: true })
  assert.equal(describeUserAgent(UA.expoGo).label, 'Mikka · iPhone')
  assert.equal(describeUserAgent(UA.chromeMac).app, false)
})

test('an unknown or missing User-Agent gives what is known, else nothing', () => {
  assert.deepEqual(describeUserAgent(null), { client: null, os: null, label: null, app: false })
  assert.deepEqual(describeUserAgent(''), { client: null, os: null, label: null, app: false })
  assert.equal(describeUserAgent('curl/8.7.1').label, null)
  assert.equal(describeUserAgent('SomeBot (Windows NT 10.0)').label, 'Windows')
  // A huge header is cut before matching.
  assert.equal(describeUserAgent(`${'x'.repeat(5000)} Chrome/1`).label, null)
})

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16])
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50])
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')

test('an avatar is a real PNG, JPEG or WebP whose bytes match its declared type', () => {
  assert.equal(sniffAvatarType(PNG), 'image/png')
  assert.equal(sniffAvatarType(JPEG), 'image/jpeg')
  assert.equal(sniffAvatarType(WEBP), 'image/webp')
  assert.equal(sniffAvatarType(SVG), null)
  assert.deepEqual(checkAvatarFile('image/png', PNG), { ok: true, contentType: 'image/png', bytes: PNG })
  assert.deepEqual(checkAvatarFile('image/webp', WEBP).ok, true)
  assert.deepEqual(checkAvatarFile('image/svg+xml', SVG), { ok: false, reason: 'type' })
  // A PNG sent as JPEG, or SVG text labelled PNG, is refused.
  assert.deepEqual(checkAvatarFile('image/jpeg', PNG), { ok: false, reason: 'type' })
  assert.deepEqual(checkAvatarFile('image/png', SVG), { ok: false, reason: 'type' })
  assert.deepEqual(checkAvatarFile('image/png', new Uint8Array()), { ok: false, reason: 'type' })
  assert.deepEqual(checkAvatarFile('image/gif', new Uint8Array([0x47, 0x49, 0x46])), { ok: false, reason: 'type' })
})

test('an avatar is at most 200 KB', () => {
  const atLimit = new Uint8Array(AVATAR_MAX_BYTES); atLimit.set(PNG)
  const over = new Uint8Array(AVATAR_MAX_BYTES + 1); over.set(PNG)
  assert.equal(checkAvatarFile('image/png', atLimit).ok, true)
  assert.deepEqual(checkAvatarFile('image/png', over), { ok: false, reason: 'size' })
})

test('an uploaded avatar path loads from under the app\'s base path like the default ones', () => {
  const path = avatarPath('u_123-abc', 'a'.repeat(64))
  assert.equal(path, `/api/avatars/u_123-abc/${'a'.repeat(64)}`)
  assert.match(path, UPLOADED_AVATAR_PATH)
  assert.equal(avatarImageSrc(path), path)
  assert.doesNotMatch('/api/avatars/../secret/' + 'a'.repeat(64), UPLOADED_AVATAR_PATH)
  assert.doesNotMatch(`/api/avatars/u/${'a'.repeat(63)}`, UPLOADED_AVATAR_PATH)
})
