import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { githubContext } from './github-context'

const accessError = (code: string) => Object.assign(new Error(code), { name: 'GitHubAccessError', code })
const listed = { login: 'alexj11324', installationAccounts: ['alexj11324', 'mikka-org', 'alexj11324'], repositories: Array.from({ length: 50 }, () => ({})) }

test('a connected account is named by its login, with where the App is installed and how many repositories it reaches', async () => {
  const connection = mock.fn(async (_userId: string) => ({ githubLogin: 'alexj11324' })), list = mock.fn(async (_userId: string) => listed)
  const text = await githubContext('alex', { connection, list })
  assert.match(text, /connected GitHub account is @alexj11324\./)
  assert.match(text, /installed on @alexj11324, @mikka-org and reaches 50 repositories/)
  assert.match(text, /Never ask which account or owner/)
  assert.ok(text.split('\n').length <= 3)
  assert.deepEqual([connection.mock.calls.map(call => call.arguments), list.mock.calls.map(call => call.arguments)], [[['alex']], [['alex']]])
})

test('a legacy GitHub sign-in has no connection row: the login comes from GitHub itself', async () => {
  const text = await githubContext('alex', { connection: async () => null, list: async () => ({ ...listed, login: 'legacy-login' }) })
  assert.match(text, /@legacy-login/)
})

test('not connected says so and where to connect it', async () => {
  const text = await githubContext('alex', { connection: async () => null, list: async () => { throw accessError('githubNotConnected') } })
  assert.match(text, /^GitHub: not connected\. The person connects it in 插件 › GitHub/)
  assert.doesNotMatch(text, /@/)
})

test('a GitHub failure or a slow GitHub leaves out the count and never throws', async () => {
  const failing = await githubContext('alex', { connection: async () => ({ githubLogin: 'alexj11324' }), list: async () => { throw accessError('githubUnavailable') } })
  assert.match(failing, /@alexj11324/)
  assert.doesNotMatch(failing, /repositories\./)
  const thrown = await githubContext('alex', { connection: async () => { throw new Error('db down') }, list: async () => { throw new Error('network') } })
  assert.equal(thrown, 'Never ask which account or owner a repository is under: look it up with find_repository, or pass the name the person used to dispatch_run.')
  const loginless = await githubContext('alex', { connection: async () => null, list: async () => ({ ...listed, login: null }) })
  assert.equal(loginless.startsWith('GitHub: the person has a GitHub account connected.\nThe Mikka GitHub App is installed'), true)
  const slow = await githubContext('alex', { connection: async () => ({ githubLogin: 'alexj11324' }), list: () => new Promise(() => {}) }, 10)
  assert.doesNotMatch(slow, /reaches/)
})

test('no installation yet says where to install it', async () => {
  const text = await githubContext('alex', { connection: async () => ({ githubLogin: 'alexj11324' }), list: async () => ({ login: 'alexj11324', installationAccounts: [], repositories: [] }) })
  assert.match(text, /not installed on any account yet/)
})
