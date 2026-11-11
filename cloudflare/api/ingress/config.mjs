import { writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function ingressConfig({ release, image, origin, taskMachine }) {
  if (!/^[a-f0-9]{7,12}-[0-9]+-[0-9]+$/.test(release) || release.length > 32) throw new Error('API_INGRESS_RELEASE_INVALID')
  if (!/^registry\.cloudflare\.com\/[a-f0-9]{32}\/mikka-api@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('API_INGRESS_IMAGE_INVALID')
  if (!URL.canParse(origin) || new URL(origin).protocol !== 'https:' || new URL(origin).origin !== origin || origin.includes('*')) throw new Error('API_INGRESS_ORIGIN_INVALID')
  if (taskMachine && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(taskMachine)) throw new Error('API_INGRESS_SERVICE_INVALID')
  return {
    ...(taskMachine ? { services: [{ binding: 'TASK_MACHINE', service: taskMachine }] } : {}),
    name: 'mikka-api-' + release, main: resolve(dirname(fileURLToPath(import.meta.url)), 'worker.mjs'),
    compatibility_date: '2026-10-19', compatibility_flags: ['nodejs_compat'], workers_dev: false, preview_urls: false,
    vars: { PUBLIC_ORIGIN: origin },
    containers: [{ class_name: 'BusinessApi', image, instance_type: 'basic', max_instances: 1 }],
    durable_objects: { bindings: [{ name: 'BUSINESS_API', class_name: 'BusinessApi' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['BusinessApi'] }],
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [output, release, image, origin, taskMachine] = process.argv.slice(2)
  await writeFile(output, JSON.stringify(ingressConfig({ release, image, origin, taskMachine }), null, 2) + '\n')
}
