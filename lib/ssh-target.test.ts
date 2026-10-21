import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSafeTarget, parseSshTarget } from './ssh-target'

test('accepts the shapes a person types into the host field', () => {
  assert.equal(parseSshTarget('bridges2.psc.edu', ''), 'bridges2.psc.edu')
  assert.equal(parseSshTarget(' 158.101.98.163 ', ''), '158.101.98.163')
  assert.equal(parseSshTarget('host:2222', 'alex'), 'alex@host:2222')
  assert.equal(parseSshTarget('ec2-3-239-58-211.compute-1.amazonaws.com', 'ubuntu'), 'ubuntu@ec2-3-239-58-211.compute-1.amazonaws.com')
})

test('refuses an option-looking host, which ssh would run as a flag', () => {
  assert.equal(parseSshTarget('-oProxyCommand=sh -c whoami', ''), null)
  assert.equal(parseSshTarget('-oProxyCommand=touch /tmp/pwned', 'alex'), null)
  assert.equal(parseSshTarget('-F/etc/passwd', ''), null)
})

test('refuses shell metacharacters and whitespace', () => {
  assert.equal(parseSshTarget('host; rm -rf /', ''), null)
  assert.equal(parseSshTarget('host$(whoami)', ''), null)
  assert.equal(parseSshTarget('host`id`', ''), null)
  assert.equal(parseSshTarget('host name', ''), null)
  assert.equal(parseSshTarget('user@host', ''), null)
  assert.equal(parseSshTarget('host:22:22', ''), null)
  assert.equal(parseSshTarget('host:port', ''), null)
  assert.equal(parseSshTarget('', ''), null)
})

test('refuses an option-looking or malformed user', () => {
  assert.equal(parseSshTarget('host', '-oProxyCommand=id'), null)
  assert.equal(parseSshTarget('host', 'user;id'), null)
  assert.equal(parseSshTarget('host', 'a b'), null)
})

test('isSafeTarget catches a target that skipped validation', () => {
  assert.equal(isSafeTarget('alex@host'), true)
  assert.equal(isSafeTarget('-oProxyCommand=id'), false)
  assert.equal(isSafeTarget(''), false)
  assert.equal(isSafeTarget('host name'), false)
})
