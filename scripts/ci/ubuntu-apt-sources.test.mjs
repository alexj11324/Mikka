import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { configureUbuntuApt, rewriteSources } from './ubuntu-apt-sources.mjs'

test('Ubuntu 22 list endpoints change without changing suites, options, comments or third-party sources', () => {
  const before = `# Keep this comment
deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] http://azure.archive.ubuntu.com/ubuntu/ jammy main restricted universe multiverse
deb-src http://azure.archive.ubuntu.com/ubuntu jammy-updates main universe
deb http://azure.archive.ubuntu.com/ubuntu jammy-security main restricted
deb https://packages.microsoft.com/repos/azure-cli/ jammy main
# deb http://azure.archive.ubuntu.com/ubuntu jammy-backports main
`
  const expected = before.replace('http://azure.archive.ubuntu.com/ubuntu/', 'http://archive.ubuntu.com/ubuntu')
    .replace('http://azure.archive.ubuntu.com/ubuntu jammy-updates', 'http://archive.ubuntu.com/ubuntu jammy-updates')
    .replace('http://azure.archive.ubuntu.com/ubuntu jammy-security', 'http://security.ubuntu.com/ubuntu jammy-security')
  assert.equal(rewriteSources(before, false), expected)
  assert.equal(rewriteSources(expected, false), expected)
})

test('Ubuntu 24 deb822 direct and mirror-list sources preserve signed fields and packages', t => {
  const root = mkdtempSync(join(tmpdir(), 'mikka-ubuntu-apt-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'etc/apt/sources.list.d'), { recursive: true })
  writeFileSync(join(root, 'etc/os-release'), 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\n')
  const path = join(root, 'etc/apt/sources.list.d/ubuntu.sources')
  const stanza = (uri, suites) => `Types: deb deb-src
URIs: ${uri}
Suites: ${suites}
Components: main universe restricted multiverse
Architectures: amd64
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
`
  const before = stanza('mirror+file:/etc/apt/apt-mirrors.txt', 'noble noble-updates noble-backports') + '\n' +
    stanza('http://azure.archive.ubuntu.com/ubuntu/', 'noble-security')
  writeFileSync(path, before)
  const thirdParty = join(root, 'etc/apt/sources.list.d/vendor.sources')
  writeFileSync(thirdParty, stanza('https://example.invalid/vendor', 'stable'))
  assert.deepEqual(configureUbuntuApt({ root, platform: 'linux' }), ['etc/apt/sources.list.d/ubuntu.sources'])
  const expected = before.replace('mirror+file:/etc/apt/apt-mirrors.txt', 'http://archive.ubuntu.com/ubuntu')
    .replace('http://azure.archive.ubuntu.com/ubuntu/', 'http://security.ubuntu.com/ubuntu')
  assert.equal(readFileSync(path, 'utf8'), expected)
  assert.equal(readFileSync(thirdParty, 'utf8'), stanza('https://example.invalid/vendor', 'stable'))
  assert.deepEqual(configureUbuntuApt({ root, platform: 'linux' }), [])
  assert.equal(rewriteSources(stanza('mirror+file:///etc/apt/apt-mirrors-security.txt', 'noble-security'), true),
    stanza('http://security.ubuntu.com/ubuntu', 'noble-security'))
})

test('a combined deb822 stanza retains every suite and all trust fields', () => {
  const before = 'Types: deb\nURIs: http://azure.archive.ubuntu.com/ubuntu\nSuites: noble noble-security\nComponents: main universe\nSigned-By: /fixture/keyring.gpg\n'
  const result = rewriteSources(before, true)
  assert.equal(result, before.replace('azure.archive', 'archive').replace('noble noble-security', 'noble') + '\n\n' +
    before.replace('azure.archive', 'security').replace('noble noble-security', 'noble-security'))
  assert.equal(rewriteSources(result, true), result)
})

test('macOS and other Linux distributions are unchanged even when a matching source exists', t => {
  const root = mkdtempSync(join(tmpdir(), 'mikka-non-ubuntu-apt-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'etc/apt'), { recursive: true })
  const path = join(root, 'etc/apt/sources.list')
  const before = 'deb http://azure.archive.ubuntu.com/ubuntu noble main\n'
  writeFileSync(path, before)
  writeFileSync(join(root, 'etc/os-release'), 'ID=ubuntu\n')
  assert.deepEqual(configureUbuntuApt({ root, platform: 'darwin' }), [])
  writeFileSync(join(root, 'etc/os-release'), 'ID=debian\nID_LIKE=ubuntu\n')
  assert.deepEqual(configureUbuntuApt({ root, platform: 'linux' }), [])
  assert.equal(readFileSync(path, 'utf8'), before)
})
