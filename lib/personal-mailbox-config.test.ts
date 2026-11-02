import assert from 'node:assert/strict'
import test from 'node:test'
import { personalMailboxEnabled } from './personal-mailbox-config'
import { agentKitEnabled } from './agent-kit/config'

test('mailbox delivery and versioned definitions default on, with explicit independent kill switches', () => {
  for (const [name, enabled] of [['MIKKA_PERSONAL_MAILBOX_ENABLED', personalMailboxEnabled], ['MIKKA_AGENT_KIT', agentKitEnabled]] as const) {
    const previous = process.env[name]
    try {
      delete process.env[name]
      assert.equal(enabled(), true)
      process.env[name] = '1'
      assert.equal(enabled(), true)
      process.env[name] = '0'
      assert.equal(enabled(), false)
    } finally {
      if (previous === undefined) delete process.env[name]
      else process.env[name] = previous
    }
  }
})
