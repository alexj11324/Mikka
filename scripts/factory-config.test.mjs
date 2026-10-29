import assert from 'node:assert/strict'
import test from 'node:test'
import { factoryConfigDigest, parseFactoryConfig, readFactoryConfig } from './factory-config.mjs'

const valid = `
schemaVersion: v1alpha1
name: mikka
repositories:
  - owner: alexj11324
    name: Mikka
agentDefaults:
  harness:
    type: codex
    model: default
  runner: linux-default
  secrets: [repo-token]
credentialStrategy: creator
runners:
  - name: linux-default
    os: linux
    arch: x64
    instanceShape:
      vcpus: 2
      memoryGb: 4
secrets:
  - name: repo-token
`

test('a complete definition validates and produces a stable digest', () => {
  const config = parseFactoryConfig(valid)
  assert.equal(config.name, 'mikka')
  assert.equal(config.credentialStrategy, 'creator')
  assert.equal(config.runners[0].instanceShape.vcpus, 2)
  const digest = factoryConfigDigest(config)
  assert.match(digest, /^[a-f0-9]{64}$/)
  assert.equal(digest, factoryConfigDigest(parseFactoryConfig(valid)))
})

test('key order and whitespace do not change the digest, content does', () => {
  const reordered = `
name: mikka
schemaVersion: v1alpha1
secrets:
  - name: repo-token
credentialStrategy: creator
agentDefaults:
  secrets: [repo-token]
  runner: linux-default
  harness:
    model: default
    type: codex
runners:
  - name: linux-default
    os: linux
    arch: x64
    instanceShape: { memoryGb: 4, vcpus: 2 }
repositories:
  - name: Mikka
    owner: alexj11324
`
  assert.equal(factoryConfigDigest(parseFactoryConfig(valid)), factoryConfigDigest(parseFactoryConfig(reordered)))
  assert.notEqual(factoryConfigDigest(parseFactoryConfig(valid)), factoryConfigDigest(parseFactoryConfig(valid.replace('vcpus: 2', 'vcpus: 4'))))
})

test('the repository definition validates', () => {
  const { config, digest } = readFactoryConfig('factory.yaml')
  assert.equal(config.schemaVersion, 'v1alpha1')
  assert.equal(config.name, 'mikka')
  assert.match(digest, /^[a-f0-9]{64}$/)
})

test('model shorthand is accepted, but model and harness together are rejected', () => {
  assert.equal(parseFactoryConfig(valid.replace('  harness:\n    type: codex\n    model: default\n', '  model: default\n')).agentDefaults.model, 'default')
  assert.throws(() => parseFactoryConfig(valid.replace('  harness:\n    type: codex\n    model: default\n', '  model: default\n  harness:\n    type: codex\n    model: default\n')), /exactly one of model or harness/)
  assert.throws(() => parseFactoryConfig(valid.replace('  harness:\n    type: codex\n    model: default\n', '')), /exactly one of model or harness/)
})

test('missing or unknown fields fail closed', () => {
  const cases = [
    [valid.replace('schemaVersion: v1alpha1\n', ''), /schemaVersion/],
    [valid.replace('v1alpha1', 'v1alpha2'), /schemaVersion/],
    [`${valid}\nunknownKey: true\n`, /unknownKey|Unrecognized/],
    [valid.replace('runner: linux-default', 'runner: missing'), /unknown runner missing/],
    [valid.replace('secrets: [repo-token]', 'secrets: [other-token]'), /unknown secret other-token/],
    [valid.replace('  - name: repo-token\n', '  - name: repo-token\n    value: secret\n'), /Unrecognized|value/],
    [valid.replace('  - name: repo-token\n', '  - name: repo-token\n  - name: repo-token\n'), /duplicate secret repo-token/],
    [valid.replace('secrets:\n  - name: repo-token', '  - name: linux-default\n    os: linux\nsecrets:\n  - name: repo-token'), /duplicate runner linux-default/],
    [valid.replace('vcpus: 2', 'vcpus: 3'), /power of two/],
    [valid.replace('name: mikka', 'name: Mikka'), /lower-case identifier/],
    [valid.replace('      vcpus: 2\n      memoryGb: 4\n', ''), /instanceShape|Unrecognized/],
  ]
  for (const [source, expected] of cases) assert.throws(() => parseFactoryConfig(source), expected)
})

test('malformed YAML, duplicate keys and prototype keys fail closed', () => {
  assert.throws(() => parseFactoryConfig('schemaVersion: [unclosed'), /invalid YAML/)
  assert.throws(() => parseFactoryConfig('schemaVersion: v1alpha1\nschemaVersion: v1alpha1\n'), /duplicated mapping key/)
  assert.throws(() => parseFactoryConfig(`${valid}\n__proto__: {polluted: true}\n`), /forbidden key/)
  assert.throws(() => parseFactoryConfig('- not\n- a\n- mapping\n'), /root must be a mapping/)
})

test('empty repositories are allowed, secret names are required to be identifiers', () => {
  const empty = valid.replace('repositories:\n  - owner: alexj11324\n    name: Mikka\n', 'repositories: []\n')
  assert.deepEqual(parseFactoryConfig(empty).repositories, [])
  assert.throws(() => parseFactoryConfig(valid.replace('  - name: repo-token', '  - name: repo token')), /lower-case identifier/)
})
