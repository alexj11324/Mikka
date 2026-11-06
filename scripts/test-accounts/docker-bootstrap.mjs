#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { EnvironmentError } from './database-target.mjs'
import { bootstrapDockerEnvironment, recordRunnerEvidenceSecrets } from './bootstrap.mjs'
import { verifyDockerOwnership } from './docker-ownership.mjs'

async function main() {
  const args = process.argv.slice(2)
  if (args.length !== 4 || args[0] !== '--sandbox' || args[2] !== '--output') throw new EnvironmentError('USAGE_DOCKER_BOOTSTRAP_SANDBOX_OUTPUT')
  if (process.platform !== 'linux') throw new EnvironmentError('DOCKER_BOOTSTRAP_LINUX_REQUIRED')
  let input = ''
  for await (const chunk of process.stdin) {
    input += chunk.toString('utf8')
    if (input.length > 20_000) throw new EnvironmentError('DOCKER_OWNER_CREDENTIAL_REQUIRED')
  }
  let credential
  try { credential = JSON.parse(input) } catch { throw new EnvironmentError('DOCKER_OWNER_CREDENTIAL_REQUIRED') }
  input = ''
  const options = {
    sandboxUid: args[1], port: 3000, origin: process.env.BETTER_AUTH_URL,
    deploymentSha: process.env.MIKKA_TEST_DEPLOYMENT_SHA, connectionString: process.env.E2E_DATABASE_URL,
  }
  const ownership = await verifyDockerOwnership({ ...options, accessToken: credential.accessToken })
  credential = undefined
  const environment = await bootstrapDockerEnvironment({ ...options, ownership, id: `docker-${randomUUID()}`, outputFile: args[3] })
  await recordRunnerEvidenceSecrets(environment)
  console.log(JSON.stringify({ environmentId: environment.id, deploymentSha: environment.deploymentSha, origin: environment.origin, status: 'prepared' }))
}

main().catch(error => {
  console.error(`Docker test environment bootstrap blocked (${error instanceof EnvironmentError ? error.code : 'UNEXPECTED_ERROR'}).`)
  process.exitCode = 1
})
