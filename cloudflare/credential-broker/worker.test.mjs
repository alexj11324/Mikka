import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { ingressConfig } from '../api/ingress/config.mjs'

const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  const modules = {
    'cloudflare:workers': 'export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env } }',
    '@cloudflare/containers': `export class Container {
      constructor(ctx, env) { this.ctx = ctx; this.env = env }
      async start() { this.ctx.events.push('start') }
      async startAndWaitForPorts() { this.ctx.events.push('startAndWaitForPorts') }
    }
    export class ContainerProxy {}
    export function getContainer(binding, name) { return binding.getByName(name) }`,
    capnweb: 'export class RpcTarget {} export function newWebSocketRpcSession() { throw new Error("Unrelated task transport invoked") }',
  }
  if (modules[specifier]) return { url: 'data:text/javascript,' + encodeURIComponent(modules[specifier]), shortCircuit: true }
  return nextResolve(specifier, context)
} })
const { default: brokerWorker, CredentialBroker, CredentialBrokerRuntime } = await import('./worker.mjs')
const { BusinessApi } = await import('../api/ingress/worker.mjs')
hooks.deregister()

const configuration = {
  PUBLIC_ORIGIN: 'https://app.example', CREDENTIAL_ENVIRONMENT: 'preview',
  CREDENTIAL_APP_ROLE_ARN: 'arn:aws:iam::123456789012:role/mikka-credential-app-preview',
  CREDENTIAL_BROKER_ROLE_ARN: 'arn:aws:iam::123456789012:role/mikka-credential-broker-preview',
  CREDENTIAL_KMS_KEY_ARN: 'arn:aws:kms:us-east-1:123456789012:key/mrk-fixture', AWS_REGION: 'us-east-1',
  MIKKA_DATABASE_URL: 'postgres://isolated-fixture', CREDENTIAL_IDENTITY: {}, CREDENTIAL_BROKER: {},
  AWS_ACCESS_KEY_ID: 'must-not-enter-container', AWS_SECRET_ACCESS_KEY: 'must-not-enter-container',
  SIGNING_KEY: { get() { assert.fail('Signer authority reached a workload') } },
}

function context() {
  const events = []
  return {
    events,
    container: { async interceptOutboundHttps(host, entrypoint) { events.push(host); assert.ok(entrypoint) } },
    exports: { CredentialIdentityOutbound: {}, CredentialBrokerOutbound: {} },
  }
}

test('each workload receives its own role and intercepts before every supported container start path', async () => {
  for (const environment of ['preview', 'production', 'customer_stage']) {
    for (const Host of [BusinessApi, CredentialBrokerRuntime]) {
      const ctx = context()
      const host = new Host(ctx, { ...configuration, CREDENTIAL_ENVIRONMENT: environment })
      assert.equal(host.envVars.CREDENTIAL_RUNTIME, 'cloudflare')
      assert.equal(host.envVars.CREDENTIAL_ENVIRONMENT, environment)
      assert.equal(host.envVars.NODE_EXTRA_CA_CERTS, '/etc/cloudflare/certs/cloudflare-containers-ca.crt')
      assert.equal(host.envVars.AWS_ACCESS_KEY_ID, undefined)
      assert.equal(host.envVars.AWS_SECRET_ACCESS_KEY, undefined)
      assert.equal(host.envVars.SIGNING_KEY, undefined)
      const app = Host === BusinessApi
      assert.equal(host.envVars[app ? 'CREDENTIAL_APP_ROLE_ARN' : 'CREDENTIAL_BROKER_ROLE_ARN'], configuration[app ? 'CREDENTIAL_APP_ROLE_ARN' : 'CREDENTIAL_BROKER_ROLE_ARN'])
      assert.equal(host.envVars[app ? 'CREDENTIAL_BROKER_ROLE_ARN' : 'CREDENTIAL_APP_ROLE_ARN'], undefined)
      await host.start()
      await host.startAndWaitForPorts()
      const intercepts = app ? ['identity.internal', 'broker.internal'] : ['identity.internal']
      assert.deepEqual(ctx.events, [...intercepts, 'start', ...intercepts, 'startAndWaitForPorts'])
    }
  }
})

test('incomplete runtime bindings fail before a container starts and an unbound app keeps its existing runtime', () => {
  assert.throws(() => new BusinessApi(context(), { ...configuration, CREDENTIAL_BROKER: undefined }))
  assert.throws(() => new CredentialBrokerRuntime(context(), { ...configuration, CREDENTIAL_IDENTITY: undefined }))
  for (const Host of [BusinessApi, CredentialBrokerRuntime]) {
    for (const environment of [undefined, '', 42]) {
      assert.throws(() => new Host(context(), { ...configuration, CREDENTIAL_ENVIRONMENT: environment }))
    }
    assert.throws(() => new Host(context(), { ...configuration, CREDENTIAL_KMS_KEY_ARN: undefined }))
  }
  const legacy = new BusinessApi(context(), { PUBLIC_ORIGIN: 'https://app.example' })
  assert.equal(legacy.envVars.CREDENTIAL_RUNTIME, undefined)
})

test('public Broker HTTP never dispatches fill while its named entrypoint reaches the fixed private container', async () => {
  let calls = 0
  const env = { CREDENTIAL_BROKER_RUNTIME: { getByName(name) {
    assert.equal(name, 'broker')
    return { async fetch(request) {
      calls++
      assert.equal(request.url, 'https://broker.internal/api/fill')
      assert.deepEqual(await request.json(), { lease: 'existing-pg-lease' })
      return Response.json({ status: 'guarded', origin: 'https://example.com' })
    } }
  } } }
  const options = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"lease":"existing-pg-lease"}' }
  for (const path of ['/api/fill', '/api/oidc', '/health.json']) {
    assert.equal((await brokerWorker.fetch(new Request('https://public.example' + path, options), env)).status, 404)
  }
  assert.equal(calls, 0)
  const response = await new CredentialBroker({}, env).fetch(new Request('https://broker.internal/api/fill', options))
  assert.equal(response.status, 200)
  assert.equal(calls, 1)
})

test('the ingress configuration maps supplied credential services to workload entrypoints', () => {
  const input = {
    release: 'a'.repeat(12) + '-1-1', origin: 'https://app.example',
    image: 'registry.cloudflare.com/' + 'b'.repeat(32) + '/mikka-api@sha256:' + 'c'.repeat(64),
    credentialIdentityService: 'identity-preview', credentialBrokerService: 'broker-preview',
  }
  assert.deepEqual(ingressConfig(input).services, [
    { binding: 'CREDENTIAL_IDENTITY', service: 'identity-preview', entrypoint: 'AppIdentity' },
    { binding: 'CREDENTIAL_BROKER', service: 'broker-preview', entrypoint: 'CredentialBroker' },
  ])
  assert.deepEqual(ingressConfig({ ...input, credentialIdentityService: undefined }).services, [
    { binding: 'CREDENTIAL_BROKER', service: input.credentialBrokerService, entrypoint: 'CredentialBroker' },
  ])
  assert.deepEqual(ingressConfig({ ...input, credentialBrokerService: undefined }).services, [
    { binding: 'CREDENTIAL_IDENTITY', service: input.credentialIdentityService, entrypoint: 'AppIdentity' },
  ])
})
