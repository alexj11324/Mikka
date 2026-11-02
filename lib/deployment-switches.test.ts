import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { DEPLOYMENT_DISTINCT_ID, DEPLOYMENT_SWITCHES, deploymentSwitch, refreshDeploymentSwitches, resetDeploymentSwitches } from './deployment-switches'

const posthog = (flags: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  const requests: unknown[] = []
  const fetcher = (async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)))
    return Response.json({ errorsWhileComputingFlags: false, flags, ...extra })
  }) as unknown as typeof fetch
  return { fetcher, requests }
}
const flag = (enabled: boolean) => ({ enabled, variant: null })

beforeEach(() => resetDeploymentSwitches())

test('without PostHog a switch reads the old variable, then its default', () => {
  assert.equal(deploymentSwitch('issueTools', {}), true, 'shipped on')
  assert.equal(deploymentSwitch('issueTools', { MIKKA_ISSUE_TOOLS_ENABLED: '0' }), false)
  assert.equal(deploymentSwitch('factoryRouting', {}), false, 'ships off')
  assert.equal(deploymentSwitch('factoryRouting', { MIKKA_FACTORY_ROUTING_ENABLED: '1' }), true)
  assert.equal(deploymentSwitch('cloudComputerTasks', { MIKKA_CLOUD_COMPUTER_TASKS: '0' }), false)
  assert.equal(deploymentSwitch('cloudComputerTasks', { MIKKA_CLOUD_COMPUTER_TASKS: 'yes' }), true, 'only 0 turned it off')
  assert.equal(deploymentSwitch('proactiveProfile', { PROACTIVE_PROFILE_ENABLED: 'TRUE' }), true)
  assert.equal(deploymentSwitch('credentialVault', {}), true)
  assert.equal(deploymentSwitch('factoryVercelPublication', { FACTORY_VERCEL_PUBLICATION: '1' }), true)
})

test('PostHog decides once it answers: a kill flag turns a shipped feature off, a gate flag turns one on', async () => {
  const { fetcher, requests } = posthog({ 'mikka-issue-tools-off': flag(true), 'mikka-factory-routing': flag(true), 'mikka-factory-vercel-publication': flag(false) })
  await refreshDeploymentSwitches('phc_test', fetcher)
  assert.equal(deploymentSwitch('issueTools', {}), false)
  assert.equal(deploymentSwitch('factoryRouting', {}), true)
  // An explicit false wins over the old variable that turned it on.
  assert.equal(deploymentSwitch('factoryVercelPublication', { FACTORY_VERCEL_PUBLICATION: '1' }), false)
  // A flag PostHog does not have leaves the old variable and default in charge.
  assert.equal(deploymentSwitch('factoryLifecycle', { MIKKA_FACTORY_LIFECYCLE_ENABLED: '1' }), true)
  assert.deepEqual(requests, [{ api_key: 'phc_test', distinct_id: DEPLOYMENT_DISTINCT_ID, flag_keys_to_evaluate: Object.values(DEPLOYMENT_SWITCHES).map(entry => entry.flag) }])
})

test('a kill flag created inactive never turns a shipped feature off', async () => {
  await refreshDeploymentSwitches('phc_test', posthog({ 'mikka-personal-mailbox-off': flag(false) }).fetcher)
  assert.equal(deploymentSwitch('personalMailbox', {}), true)
  assert.equal(deploymentSwitch('personalMailbox', { MIKKA_PERSONAL_MAILBOX_ENABLED: '0' }), true, 'PostHog answered; the old variable no longer decides')
})

test('an outage, a partial evaluation or a multivariate flag keeps what was known', async () => {
  await refreshDeploymentSwitches('phc_test', posthog({ 'mikka-agent-kit-off': flag(true) }).fetcher)
  assert.equal(deploymentSwitch('agentKit', {}), false)
  await refreshDeploymentSwitches('phc_test', posthog({}, { errorsWhileComputingFlags: true }).fetcher)
  await refreshDeploymentSwitches('phc_test', posthog({}, { quotaLimited: ['feature_flags'] }).fetcher)
  await refreshDeploymentSwitches('phc_test', (async () => new Response('', { status: 503 })) as unknown as typeof fetch)
  await assert.rejects(refreshDeploymentSwitches('phc_test', (async () => { throw new Error('network') }) as unknown as typeof fetch))
  assert.equal(deploymentSwitch('agentKit', {}), false, 'no answer replaced the last one')
  await refreshDeploymentSwitches('phc_test', posthog({ 'mikka-agent-kit-off': { enabled: true, variant: 'b' } }).fetcher)
  assert.equal(deploymentSwitch('agentKit', {}), true, 'a variant is not a switch answer')
  await refreshDeploymentSwitches(undefined, posthog({ 'mikka-agent-kit-off': flag(true) }).fetcher)
  assert.equal(deploymentSwitch('agentKit', {}), true, 'no project key asks nothing')
})

test('every kill flag ends in -off and ships on; every gate ships off', () => {
  for (const [name, entry] of Object.entries(DEPLOYMENT_SWITCHES)) {
    assert.equal(entry.flag.endsWith('-off'), entry.kind === 'kill', name)
    assert.equal(entry.fallback, entry.kind === 'kill', name)
    assert.match(entry.flag, /^mikka-[a-z0-9-]+$/, name)
  }
})
