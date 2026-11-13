import { writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function ingressConfig({ release, image, origin, taskMachine, eveService, businessWorld, credentialIdentityService, credentialBrokerService, workersAi = false }) {
  const account = image.split('/')[1]
  const services = [
    { binding: 'TASK_MACHINE', service: taskMachine },
    { binding: 'EVE_SERVICE', service: eveService, entrypoint: 'EveService' },
    { binding: 'BUSINESS_WORLD', service: businessWorld, entrypoint: 'BusinessWorldService' },
    { binding: 'CREDENTIAL_IDENTITY', service: credentialIdentityService, entrypoint: 'AppIdentity' },
    { binding: 'CREDENTIAL_BROKER', service: credentialBrokerService, entrypoint: 'CredentialBroker' },
  ].filter(item => item.service !== undefined)
  return {
    ...(services.length ? { services } : {}),
    ...(workersAi ? { ai: { binding: 'WORKERS_AI' } } : {}),
    name: 'mikka-api-' + release, main: resolve(dirname(fileURLToPath(import.meta.url)), 'worker.mjs'),
    compatibility_date: '2026-10-19', compatibility_flags: ['nodejs_compat'], workers_dev: false, preview_urls: false,
    vars: { PUBLIC_ORIGIN: origin, MIKKA_DEPLOYMENT_ID: release, ...(workersAi ? { CLOUDFLARE_WORKERS_AI_ACCOUNT_ID: account } : {}) },
    containers: [{ class_name: 'BusinessApi', image, instance_type: 'basic', max_instances: 1 }],
    durable_objects: { bindings: [{ name: 'BUSINESS_API', class_name: 'BusinessApi' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['BusinessApi'] }],
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [output, release, image, origin, taskMachine, eveService, businessWorld] = process.argv.slice(2)
  await writeFile(output, JSON.stringify(ingressConfig({ release, image, origin, taskMachine, eveService, businessWorld }), null, 2) + '\n')
}
