import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { DEFAULT_AVATARS, defaultAvatarSrc } from './default-avatar'

test('the same person gets the same default avatar, whatever the case or spacing', () => {
  assert.equal(defaultAvatarSrc('Lin'), defaultAvatarSrc(' lin '))
  assert.match(defaultAvatarSrc('a@example.com'), /^\/avatars\/(blue|green|purple|orange|red)\.webp$/)
})

test('different people spread over all five colors', () => {
  const used = new Set(Array.from({ length: 50 }, (_, i) => defaultAvatarSrc(`person ${i}`)))
  assert.equal(used.size, DEFAULT_AVATARS.length)
})

test('every default avatar ships in public/avatars', () => {
  for (const name of DEFAULT_AVATARS) assert.ok(existsSync(new URL(`../public/avatars/${name}.webp`, import.meta.url)), name)
})
