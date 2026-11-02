import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connectKind, credentialForms, readCredentials } from './connect-kind'

test('how an app connects follows its Composio auth schemes', () => {
  assert.equal(connectKind({ composio_managed_auth_schemes: ['OAUTH2'], auth_schemes: ['OAUTH2', 'API_KEY'] }), 'managed')
  assert.equal(connectKind({ composio_managed_auth_schemes: [], auth_schemes: ['API_KEY'] }), 'credentials')
  assert.equal(connectKind({ auth_schemes: ['BEARER_TOKEN', 'API_KEY'] }), 'credentials')
  assert.equal(connectKind({ auth_schemes: ['BASIC'] }), 'credentials')
  assert.equal(connectKind({ no_auth: true, composio_managed_auth_schemes: ['OAUTH2'] }), 'none')
  assert.equal(connectKind({ auth_schemes: ['NO_AUTH'] }), 'none')
  // OAuth without Composio's managed app would need a developer app of the person's own.
  assert.equal(connectKind({ auth_schemes: ['OAUTH2', 'DCR_OAUTH'] }), 'unsupported')
  assert.equal(connectKind({}), 'unsupported')
})

// Shaped like Composio's v3 toolkit detail for Exa and Firecrawl.
const DETAILS = [
  { mode: 'BEARER_TOKEN', fields: { connected_account_initiation: { required: [{ name: 'token', displayName: 'Bearer Token', description: 'Your  Exa\nkey', is_secret: true, required: true, type: 'string' }], optional: [] } } },
  { mode: 'API_KEY', fields: { connected_account_initiation: {
    required: [{ name: 'generic_api_key', displayName: 'API Key', is_secret: true, required: true, type: 'string' }],
    optional: [{ name: 'full', displayName: 'Base URL', default: 'https://api.firecrawl.dev/v1', is_secret: false, required: false, type: 'string' }, { name: 'hidden', user_visible: false, type: 'string' }, { name: 'Bad Name', type: 'string' }, { name: 'count', type: 'number' }],
  } } },
  { mode: 'OAUTH2', fields: { connected_account_initiation: { required: [{ name: 'client_id', type: 'string' }] } } },
  { mode: 'API_KEY', fields: { connected_account_initiation: { required: [{ name: 'other', type: 'string' }] } } },
]

test('the form is Composio\'s own fields for each credential scheme, in its order', () => {
  const forms = credentialForms(DETAILS)
  assert.deepEqual(forms.map(form => form.scheme), ['BEARER_TOKEN', 'API_KEY'])
  assert.deepEqual(forms[0].fields, [{ name: 'token', label: 'Bearer Token', description: 'Your Exa key', secret: true, required: true, defaultValue: null }])
  // Hidden, oddly named and non-text fields are left out.
  assert.deepEqual(forms[1].fields.map(field => [field.name, field.required, field.defaultValue]), [['generic_api_key', true, null], ['full', false, 'https://api.firecrawl.dev/v1']])
  assert.deepEqual(credentialForms(null), [])
})

test('what a person submits must fit the form', () => {
  const [, form] = credentialForms(DETAILS)
  assert.deepEqual(readCredentials(form, { generic_api_key: '  fc-key  ' }), { generic_api_key: 'fc-key', full: 'https://api.firecrawl.dev/v1' })
  assert.deepEqual(readCredentials(form, { generic_api_key: 'fc-key', full: 'https://eu.firecrawl.dev' }), { generic_api_key: 'fc-key', full: 'https://eu.firecrawl.dev' })
  assert.equal(readCredentials(form, {}), null)
  assert.equal(readCredentials(form, { generic_api_key: '   ' }), null)
  assert.equal(readCredentials(form, { generic_api_key: 'k', extra: 'x' }), null)
  assert.equal(readCredentials(form, { generic_api_key: 42 }), null)
  assert.equal(readCredentials(form, { generic_api_key: 'k'.repeat(4097) }), null)
  assert.equal(readCredentials(form, ['k']), null)
})
