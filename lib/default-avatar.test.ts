import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { DEFAULT_AVATARS, avatarImageSrc, newUserAvatar } from './default-avatar'

test('a new account gets the same default avatar for the same name, whatever the case or spacing', () => {
  assert.equal(newUserAvatar('Lin'), newUserAvatar(' lin '))
  assert.match(newUserAvatar('a@example.com'), /^\/avatars\/(blue|green|purple|orange|red)\.webp$/)
})

test('names spread over all five colors', () => {
  const used = new Set(Array.from({ length: 50 }, (_, i) => newUserAvatar(`person ${i}`)))
  assert.equal(used.size, DEFAULT_AVATARS.length)
})

test('stored default avatars load from the app, provider pictures as given, no image is no image', () => {
  assert.equal(avatarImageSrc('/avatars/blue.webp'), '/avatars/blue.webp')
  assert.equal(avatarImageSrc('https://avatars.githubusercontent.com/u/1'), 'https://avatars.githubusercontent.com/u/1')
  assert.equal(avatarImageSrc('/avatars/../secret.webp'), '/avatars/../secret.webp')
  assert.equal(avatarImageSrc(null), undefined)
  assert.equal(avatarImageSrc(''), undefined)
})

test('every default avatar ships in public/avatars', () => {
  for (const name of DEFAULT_AVATARS) assert.ok(existsSync(new URL(`../public/avatars/${name}.webp`, import.meta.url)), name)
})
