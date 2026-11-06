import { execFileSync } from 'node:child_process'
import https from 'node:https'
import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'
import { EnvironmentError } from './database-target.mjs'
import { dockerDatabaseTarget, dockerOrigin, validateDockerBinding } from './docker-target.mjs'

const API = 'https://connect.docker.com/sandboxes/v1/'
const receipts = new WeakMap()
const PROOF_LIFETIME_MS = 60_000
const fail = code => { throw new EnvironmentError(code) }

// No injectable transport, URL, redirects, request body or mutation method.
// The caller supplies a short-lived owner token in memory; it is never part of
// the returned receipt, descriptor, environment or any error message.
async function readOwnedResource(path, accessToken) {
  return new Promise((resolve, reject) => {
    const request = https.request(new URL(path, API), {
      method: 'GET', headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    }, response => {
      // Edge responses may set cookies. This bearer-only transport has no jar
      // and never carries response cookies into the next management request.
      if (response.statusCode !== 200 || response.headers.location) {
        response.resume()
        reject(new EnvironmentError('DOCKER_OWNERSHIP_REJECTED'))
        return
      }
      const chunks = []
      let length = 0
      response.on('data', chunk => {
        length += chunk.length
        if (length > 65_536) { response.destroy(); reject(new EnvironmentError('DOCKER_OWNERSHIP_RESPONSE_INVALID')); return }
        chunks.push(chunk)
      })
      response.on('error', () => reject(new EnvironmentError('DOCKER_OWNERSHIP_UNAVAILABLE')))
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch { reject(new EnvironmentError('DOCKER_OWNERSHIP_RESPONSE_INVALID')) }
      })
    })
    request.on('error', () => reject(new EnvironmentError('DOCKER_OWNERSHIP_UNAVAILABLE')))
    request.setTimeout(10_000, () => { request.destroy(); reject(new EnvironmentError('DOCKER_OWNERSHIP_UNAVAILABLE')) })
    request.end()
  })
}

/** Only a successful, authenticated live management lookup can create a receipt. */
export async function verifyDockerOwnership({ accessToken, sandboxUid, port, origin, deploymentSha, connectionString, appDirectory = process.cwd() }) {
  if (typeof accessToken !== 'string' || accessToken.length < 20 || accessToken.length > 16_384 || !/^[A-Za-z0-9._~+/-]+=*$/.test(accessToken)) fail('DOCKER_OWNER_CREDENTIAL_REQUIRED')
  if (dockerOrigin(sandboxUid, port) !== origin) fail('DOCKER_PUBLICATION_MISMATCH')
  const database = dockerDatabaseTarget(connectionString)
  if (!/^[a-f0-9]{40}$/.test(deploymentSha ?? '')) fail('DEPLOYMENT_SHA_MISMATCH')
  let checkedOut
  try { checkedOut = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(appDirectory), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() }
  catch { fail('CHECKED_OUT_SHA_UNAVAILABLE') }
  if (checkedOut !== deploymentSha) fail('CHECKED_OUT_SHA_MISMATCH')
  const name = `sandboxes/${sandboxUid}`
  const sandbox = await readOwnedResource(name, accessToken)
  if (!sandbox || sandbox.name !== name || sandbox.uid !== sandboxUid || sandbox.core?.status !== 'running' || sandbox.core?.endpoint?.sandbox !== name || sandbox.core?.endpoint?.sandboxUid !== sandboxUid) fail('DOCKER_SANDBOX_MISMATCH')
  const ports = await readOwnedResource(`${name}/ports`, accessToken)
  const published = Array.isArray(ports?.published) ? ports.published.filter(item => item?.number === port) : []
  const advertised = Array.isArray(sandbox.core.ports) ? sandbox.core.ports.filter(item => item?.sandboxPort === port) : []
  if (published?.length !== 1 || advertised?.length !== 1 || advertised[0].url !== origin) fail('DOCKER_PUBLICATION_MISMATCH')
  const publication = published[0]
  if (publication.name !== `${name}/ports/${port}` || publication.protocol !== 'tcp' || publication.url !== origin) fail('DOCKER_PUBLICATION_MISMATCH')
  const docker = validateDockerBinding({ sandboxUid, port, publicationUid: publication.uid }, origin)
  const receipt = Object.freeze({ docker, origin, deploymentSha, database })
  receipts.set(receipt, { expires: performance.now() + PROOF_LIFETIME_MS })
  return receipt
}

/** A receipt is consumed once before the first database connection or write. */
export function consumeDockerOwnership(receipt, { origin, deploymentSha, connectionString }) {
  const proof = receipt && receipts.get(receipt)
  if (!proof) fail('DOCKER_OWNERSHIP_PROOF_REQUIRED')
  receipts.delete(receipt)
  if (performance.now() >= proof.expires) fail('DOCKER_OWNERSHIP_PROOF_EXPIRED')
  const database = dockerDatabaseTarget(connectionString)
  if (receipt.origin !== origin || receipt.deploymentSha !== deploymentSha || JSON.stringify(receipt.database) !== JSON.stringify(database)) fail('DOCKER_OWNERSHIP_BINDING_MISMATCH')
  return receipt.docker
}
