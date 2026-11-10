import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes } from 'node:crypto'
import { applyScimPatch, parseScim, SCIM_GROUP, SCIM_PATCH, SCIM_USER, ScimError, scimFailure, scimGroupInput, scimQuery, scimUserInput } from './scim-protocol'
import { enterpriseAccessAllowed, type EnterpriseAccessState } from './access-policy'
import { decryptSsoConfig, encryptSsoConfig, enterpriseSso } from './sso-plugin'

test('SCIM active=false is a boolean, not a truthy string; external identity is required', () => {
  const user = parseScim(scimUserInput, { schemas: [SCIM_USER], externalId: 'CaseSensitiveSubject', userName: 'USER@example.org', active: false })
  assert.equal(user.active, false); assert.equal(user.userName, 'user@example.org'); assert.equal(user.externalId, 'CaseSensitiveSubject')
  assert.throws(() => parseScim(scimUserInput, { ...user, active: 'false' }), ScimError)
  assert.throws(() => parseScim(scimUserInput, { ...user, externalId: undefined }), ScimError)
})
test('SCIM patch cannot add roles, entitlement grants or prototype fields', () => {
  const user = parseScim(scimUserInput, { schemas: [SCIM_USER], externalId: 's', userName: 'user@example.org' })
  assert.equal(applyScimPatch('Users', user, { schemas: [SCIM_PATCH], Operations: [{ op: 'Replace', path: 'active', value: false }] }).active, false)
  for (const path of ['roles', '__proto__', 'constructor', 'workspaceId', 'active.value'])
    assert.throws(() => applyScimPatch('Users', user, { schemas: [SCIM_PATCH], Operations: [{ op: 'add', path, value: 'admin' }] }), ScimError)
  assert.equal(user.active, true, 'patch evaluation preserves the input snapshot')
})
test('SCIM group member add/remove is deduplicated and bounded', () => {
  const member = { value: '2a7d0ab1-cb4b-4625-83cf-042646c34e5f' }
  const group = parseScim(scimGroupInput, { schemas: [SCIM_GROUP], displayName: 'Engineering', members: [member] })
  const added = applyScimPatch('Groups', group, { schemas: [SCIM_PATCH], Operations: [{ op: 'add', path: 'members', value: [member] }] })
  assert.equal(added.members.length, 1)
  assert.equal(applyScimPatch('Groups', added, { schemas: [SCIM_PATCH], Operations: [{ op: 'remove', path: `members[value eq "${member.value}"]` }] }).members.length, 0)
  assert.throws(() => applyScimPatch('Groups', group, { schemas: [SCIM_PATCH], Operations: [{ op: 'replace', path: 'members', value: [{ value: 'another-tenant;select' }] }] }), ScimError)
})
test('SCIM equality filter accepts escaped strings and rejects unbounded/injected predicates', () => {
  const url = new URL('https://app.example/scim/Users')
  url.searchParams.set('filter', 'userName eq "USER@example.org"')
  assert.deepEqual(scimQuery(url, 'Users'), { startIndex: 1, count: 100, filter: { field: 'userName', value: 'user@example.org' } })
  for (const filter of ['userName pr', 'userName eq "x" or externalId pr', 'password eq "x"']) {
    url.searchParams.set('filter', filter); assert.throws(() => scimQuery(url, 'Users'), ScimError)
  }
  url.searchParams.delete('filter'); url.searchParams.set('count', '100000')
  assert.throws(() => scimQuery(url, 'Users'), ScimError)
})
test('SCIM errors never return database causes or provisioning payloads', async () => {
  const response = scimFailure(new Error('postgres password=DO_NOT_EXPOSE_TOKEN'))
  assert.equal(response.status, 500)
  assert.equal((await response.text()).includes('DO_NOT_EXPOSE_TOKEN'), false)
})
test('enforced SSO distinguishes humans, explicit machine authorization, and revocation', () => {
  const base: EnterpriseAccessState = { managedRevoked: false, enforceSso: true, allowMachineCredentials: false, credentialValid: true, sessionAssured: false, breakGlass: false }
  const human = { kind: 'session' as const, sessionId: 'session' }
  const machine = { kind: 'pat' as const, tokenId: 'token', workspaceId: 'workspace' }
  const admission = { kind: 'admission' as const, runId: 'run', workspaceId: 'workspace' }
  const collaboration = { kind: 'collaboration' as const, authorizationId: 'receipt', workspaceId: 'workspace' }
  assert.equal(enterpriseAccessAllowed(base, human), false)
  assert.equal(enterpriseAccessAllowed({ ...base, sessionAssured: true }, human), true)
  assert.equal(enterpriseAccessAllowed({ ...base, sessionAssured: true }, machine), false)
  for (const principal of [machine, admission, collaboration]) {
    assert.equal(enterpriseAccessAllowed(base, principal), false)
    assert.equal(enterpriseAccessAllowed({ ...base, allowMachineCredentials: true }, principal), true)
    assert.equal(enterpriseAccessAllowed({ ...base, allowMachineCredentials: true, credentialValid: false }, principal), false)
    assert.equal(enterpriseAccessAllowed({ ...base, allowMachineCredentials: true, managedRevoked: true }, principal), false)
  }
  assert.equal(enterpriseAccessAllowed({ ...base, breakGlass: true }, human), true)
  assert.equal(enterpriseAccessAllowed({ ...base, breakGlass: true, managedRevoked: true }, human), false)
  assert.equal(enterpriseAccessAllowed({ ...base, allowMachineCredentials: true }), false)
  assert.equal(enterpriseAccessAllowed({ ...base, enforceSso: false }), true)
})
test('provider secrets and SAML certificates are encrypted and cannot move between config types', () => {
  const previous = process.env.WORKSPACE_SECRETS_KEY
  process.env.WORKSPACE_SECRETS_KEY = randomBytes(32).toString('hex')
  try {
    const config = { clientSecret: 'fixture-secret-never-in-db', issuer: 'https://idp.example' }
    const sealed = encryptSsoConfig(config, 'oidcConfig')
    assert.equal(sealed.includes(config.clientSecret), false)
    assert.deepEqual(JSON.parse(decryptSsoConfig(sealed, 'oidcConfig')), config)
    assert.throws(() => decryptSsoConfig(sealed, 'samlConfig'))
    const plugin = enterpriseSso()
    assert.equal(plugin.options.providersLimit, 0)
    assert.equal(plugin.options.organizationProvisioning?.disabled, true)
    assert.equal(plugin.options.saml?.allowIdpInitiated, false)
    assert.ok(plugin.schema.ssoProvider.fields.oidcConfig.transform)
  } finally { if (previous === undefined) delete process.env.WORKSPACE_SECRETS_KEY; else process.env.WORKSPACE_SECRETS_KEY = previous }
})
