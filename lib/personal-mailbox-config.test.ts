import assert from 'node:assert/strict'
import test from 'node:test'
import { personalMailboxEnabled } from './personal-mailbox-config'
import { agentKitEnabled } from './agent-kit/config'
import { overrideDeploymentSwitch } from './deployment-switches'

test('versioned definitions default on, with an explicit independent kill switch', () => {
  const name = 'MIKKA_AGENT_KIT'
  const previous = process.env[name]
  try {
    delete process.env[name]
    assert.equal(agentKitEnabled(), true)
    process.env[name] = '1'
    assert.equal(agentKitEnabled(), true)
    process.env[name] = '0'
    assert.equal(agentKitEnabled(), false)
    assert.equal(personalMailboxEnabled(), true, 'independent of the mailbox')
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
})

test('mailbox delivery defaults on; only its kill switch turns it off', () => {
  const previous = process.env.MIKKA_PERSONAL_MAILBOX_ENABLED
  try {
    assert.equal(personalMailboxEnabled(), true)
    overrideDeploymentSwitch('personalMailbox', false)
    assert.equal(personalMailboxEnabled(), false)
    assert.equal(agentKitEnabled(), true, 'independent of versioned definitions')
    overrideDeploymentSwitch('personalMailbox', true)
    assert.equal(personalMailboxEnabled(), true)
    overrideDeploymentSwitch('personalMailbox', undefined)
    process.env.MIKKA_PERSONAL_MAILBOX_ENABLED = '0'
    assert.equal(personalMailboxEnabled(), true, 'the old variable no longer decides')
  } finally {
    overrideDeploymentSwitch('personalMailbox', undefined)
    if (previous === undefined) delete process.env.MIKKA_PERSONAL_MAILBOX_ENABLED
    else process.env.MIKKA_PERSONAL_MAILBOX_ENABLED = previous
  }
})
