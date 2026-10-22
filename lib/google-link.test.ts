import assert from 'node:assert/strict'
import { test } from 'node:test'
import { completeGoogleLink } from './google-link'

test('marks the authenticated user verified only after a linked Google account exists', async () => {
  let updatedUserId = ''
  const updateUser = async (userId: string) => {
    updatedUserId = userId
    return { id: userId }
  }

  assert.equal(await completeGoogleLink('user-1', [{ providerId: 'github' }], updateUser), false)
  assert.equal(updatedUserId, '')
  assert.equal(await completeGoogleLink('user-1', [{ providerId: 'google' }], updateUser), true)
  assert.equal(updatedUserId, 'user-1')
})
