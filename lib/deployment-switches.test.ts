import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { DEPLOYMENT_DISTINCT_ID, DEPLOYMENT_SWITCHES, deploymentSwitch, overrideDeploymentSwitch, refreshDeploymentSwitches, resetDeploymentSwitches, deploymentName, SWITCH_REFRESH_MS, switchForPerson, type Switch } from './deployment-switches'

const posthog = (flags: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  const requests: unknown[] = []
  const fetcher = (async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)))
    return Response.json({ errorsWhileComputingFlags: false, flags, ...extra })
  }) as unknown as typeof fetch
  return { fetcher, requests }
}
const flag = (enabled: boolean) => ({ enabled, variant: null })

beforeEach(() => {
  resetDeploymentSwitches()
  for (const name of Object.keys(DEPLOYMENT_SWITCHES) as (keyof typeof DEPLOYMENT_SWITCHES)[]) overrideDeploymentSwitch(name, undefined)
})

test('without PostHog a switch reads the old variable, then its default', () => {
  assert.equal(deploymentSwitch('issueTools', {}), true, 'shipped on')
  assert.equal(deploymentSwitch('factoryRouting', {}), true, 'all task dispatch ships through Factory')
  assert.equal(deploymentSwitch('factoryRouting', { MIKKA_FACTORY_ROUTING_ENABLED: '1' }), true)
  assert.equal(deploymentSwitch('cloudComputerTasks', { MIKKA_CLOUD_COMPUTER_TASKS: '0' }), false)
  assert.equal(deploymentSwitch('cloudComputerTasks', { MIKKA_CLOUD_COMPUTER_TASKS: 'yes' }), true, 'only 0 turned it off')
  assert.equal(deploymentSwitch('proactiveProfile', { PROACTIVE_PROFILE_ENABLED: 'TRUE' }), true)
  assert.equal(deploymentSwitch('credentialVault', {}), true)
  assert.equal(deploymentSwitch('factoryVercelPublication', { FACTORY_VERCEL_PUBLICATION: '1' }), true)
})

test('a switch whose flag exists decides by PostHog and its default only; its old variable is gone', () => {
  for (const [name, variable] of [['issueTools', 'MIKKA_ISSUE_TOOLS_ENABLED'], ['personalMailbox', 'MIKKA_PERSONAL_MAILBOX_ENABLED'], ['personalWrites', 'MIKKA_PERSONAL_WRITES_ENABLED']] as const) {
    assert.equal('legacy' in DEPLOYMENT_SWITCHES[name], false, name)
    for (const value of ['0', '1', 'false', '']) assert.equal(deploymentSwitch(name, { [variable]: value }), true, `${variable}=${value}`)
  }
  // On in production but off by default: keeps its variable so a fresh process does not turn it off.
  assert.equal(deploymentSwitch('byosEnrollment', { MIKKA_EDITION: 'cloud' }), false)
  assert.equal(deploymentSwitch('byosEnrollment', {}), true, 'community uses the deployed enrollment default without PostHog')
  assert.equal(deploymentSwitch('byosEnrollment', { MIKKA_BYOS_ENROLLMENT_ENABLED: '1' }), true)
})

test('a test override wins over PostHog and the variable, and clears', async () => {
  await refreshDeploymentSwitches('phc_test', posthog({ 'mikka-issue-tools-off': flag(false), 'mikka-byos-enrollment': flag(true) }).fetcher)
  overrideDeploymentSwitch('issueTools', false)
  overrideDeploymentSwitch('byosEnrollment', false)
  assert.equal(deploymentSwitch('issueTools', {}), false)
  assert.equal(deploymentSwitch('byosEnrollment', { MIKKA_BYOS_ENROLLMENT_ENABLED: '1' }), false)
  overrideDeploymentSwitch('issueTools', undefined)
  overrideDeploymentSwitch('byosEnrollment', undefined)
  assert.equal(deploymentSwitch('issueTools', {}), true)
  assert.equal(deploymentSwitch('byosEnrollment', {}), true)
})

test('the test override is unreachable in production: it throws in a deployment or a production build, and only test code imports it', () => {
  for (const env of [{ VERCEL: '1' }, { VERCEL_ENV: 'production' }, { VERCEL_ENV: 'preview' }, { NODE_ENV: 'production' }, ...['production', 'preview', 'development'].map(stage => ({ MIKKA_DEPLOYMENT_STAGE: stage }))]) {
    assert.throws(() => overrideDeploymentSwitch('issueTools', false, env), /tests only/, JSON.stringify(env))
  }
  assert.equal(deploymentSwitch('issueTools', {}), true, 'a refused override sets nothing')
  const files = execFileSync('git', ['grep', '-l', 'overrideDeploymentSwitch', '--', '.', ':!docs'], { encoding: 'utf8' }).trim().split('\n')
  const productionFiles = files.filter(file => file !== 'lib/deployment-switches.ts' && !/(\.test|\.db)\.(ts|mts|mjs)$/.test(file) && !file.startsWith('tests/'))
  assert.deepEqual(productionFiles, [])
})

test('PostHog decides once it answers: a kill flag turns a shipped feature off, a gate flag turns one on', async () => {
  const { fetcher, requests } = posthog({ 'mikka-issue-tools-off': flag(true), 'mikka-factory-routing-off': flag(false), 'mikka-factory-vercel-publication': flag(false) })
  await refreshDeploymentSwitches('phc_test', fetcher)
  assert.equal(deploymentSwitch('issueTools', {}), false)
  assert.equal(deploymentSwitch('factoryRouting', {}), true)
  // An explicit false wins over the old variable that turned it on.
  assert.equal(deploymentSwitch('factoryVercelPublication', { FACTORY_VERCEL_PUBLICATION: '1' }), false)
  // A flag PostHog does not have leaves the old variable and default in charge.
  assert.equal(deploymentSwitch('factoryLifecycle', { MIKKA_FACTORY_LIFECYCLE_ENABLED: '1' }), true)
  assert.deepEqual(requests, [{ api_key: 'phc_test', distinct_id: DEPLOYMENT_DISTINCT_ID, flag_keys_to_evaluate: Object.values(DEPLOYMENT_SWITCHES).map(entry => entry.flag), person_properties: { deployment: deploymentName() } }])
})

test('a kill flag created inactive never turns a shipped feature off', async () => {
  await refreshDeploymentSwitches('phc_test', posthog({ 'mikka-personal-mailbox-off': flag(false) }).fetcher)
  assert.equal(deploymentSwitch('personalMailbox', {}), true)
  assert.equal(deploymentSwitch('cloudComputerTasks', { MIKKA_CLOUD_COMPUTER_TASKS: '0' }), false, 'no flag answer: the old variable still decides')
  await refreshDeploymentSwitches('phc_test', posthog({ 'mikka-cloud-computer-tasks-off': flag(false) }).fetcher)
  assert.equal(deploymentSwitch('cloudComputerTasks', { MIKKA_CLOUD_COMPUTER_TASKS: '0' }), true, 'PostHog answered; the old variable no longer decides')
})

test('group contribution kill flag restores baseline and the recognized environment policy is only a fallback',async()=>{
  assert.equal(deploymentSwitch('groupContribution',{}),true)
  assert.equal(deploymentSwitch('groupContribution',{MIKKA_GROUP_DECISION_POLICY:'group-route-v0'}),false)
  assert.equal(deploymentSwitch('groupContribution',{MIKKA_GROUP_DECISION_POLICY:'group-contribution-v1'}),true)
  assert.equal(deploymentSwitch('groupContribution',{MIKKA_GROUP_DECISION_POLICY:'group-contribution-v2'}),true)
  assert.equal(deploymentSwitch('groupContribution',{MIKKA_GROUP_DECISION_POLICY:'group-contribution-v3'}),true)
  await refreshDeploymentSwitches('phc_test',posthog({'mikka-group-contribution-off':flag(true)}).fetcher)
  assert.equal(deploymentSwitch('groupContribution',{MIKKA_GROUP_DECISION_POLICY:'group-contribution-v1'}),false)
  await refreshDeploymentSwitches('phc_test',posthog({'mikka-group-contribution-off':flag(false)}).fetcher)
  assert.equal(deploymentSwitch('groupContribution',{MIKKA_GROUP_DECISION_POLICY:'group-route-v0'}),true,'inactive flag restores the shipped candidate')
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
    if (!('legacy' in entry)) assert.equal(entry.kind, 'kill', `${name}: a gate without its variable would turn off in every fresh process`)
    assert.match(entry.flag, /^mikka-[a-z0-9-]+$/, name)
  }
})

test('a person switch is evaluated for that person, cached, and falls back the same way', async () => {
  const entry: Switch = { flag: 'mikka-example-person', kind: 'gate', legacy: env => env.EXAMPLE === undefined ? undefined : env.EXAMPLE === '1', fallback: false }
  const asked: string[] = []
  const fetcher = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { distinct_id: string }
    asked.push(body.distinct_id)
    return Response.json({ errorsWhileComputingFlags: false, flags: body.distinct_id === 'alex' ? { 'mikka-example-person': flag(true) } : {} })
  }) as unknown as typeof fetch
  const lookup = { token: 'phc_test', fetcher, env: {}, now: 1_000 }
  assert.equal(await switchForPerson(entry, 'alex', lookup), true, 'on for the person it targets')
  assert.equal(await switchForPerson(entry, 'someone', lookup), false, 'no answer for others: the default')
  assert.equal(await switchForPerson(entry, 'someone', { ...lookup, env: { EXAMPLE: '1' } }), true, 'or the old variable')
  assert.deepEqual(asked, ['alex', 'someone'], 'cached per person')
  const down = (async () => { throw new Error('network') }) as unknown as typeof fetch
  assert.equal(await switchForPerson(entry, 'alex', { ...lookup, fetcher: down, now: 1_000 + SWITCH_REFRESH_MS }), true, 'an outage keeps what was known')
  assert.equal(await switchForPerson(entry, 'alex', { ...lookup, token: '' , now: 1_000 }), true)
  resetDeploymentSwitches()
  assert.equal(await switchForPerson(entry, 'alex', { ...lookup, fetcher: down }), false, 'never answered: the default')
})

test('the deployment says which one it is, so a flag can be on for production only', () => {
  assert.equal(deploymentName({ MIKKA_DEPLOYMENT_STAGE: 'production' }), 'production')
  assert.equal(deploymentName({ MIKKA_DEPLOYMENT_STAGE: 'preview', VERCEL_ENV: 'production' }), 'preview')
  assert.equal(deploymentName({ MIKKA_DEPLOYMENT_STAGE: 'development', VERCEL_ENV: 'preview' }), 'development')
  assert.throws(() => deploymentName({ MIKKA_DEPLOYMENT_STAGE: 'prod' }), /MIKKA_DEPLOYMENT_STAGE_INVALID/)
  assert.equal(deploymentName({ VERCEL_ENV: 'production' }), 'production')
  assert.equal(deploymentName({ VERCEL_ENV: 'preview' }), 'preview')
  assert.equal(deploymentName({ VERCEL_ENV: 'development' }), 'development')
  assert.equal(deploymentName({}), 'local')
})
