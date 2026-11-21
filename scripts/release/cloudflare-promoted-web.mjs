import { appendFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { actionsMikkaRepository, officialMikkaRepository } from '../cloudflare-source.mjs'
import { isValidDeploymentId } from '../../lib/deployment-id.mjs'
import { containsDesktopSource, githubRead, PRODUCTION_VERSION_URL } from './web-deploy.mjs'

const ownerId = 183887963
const ownerIssue = /^https:\/\/api\.github\.com\/repos\/(alexj11324|aspectly-labs)\/Mikka\/issues\/1954$/
const officialRepository = row => officialMikkaRepository(row?.full_name, String(row?.id),
  row?.owner?.id === undefined ? undefined : String(row.owner.id))
const runtimeWorkflow = '.github/workflows/e2b-official-runtime.yml'
const desktopWorkflow = '.github/workflows/desktop-release.yml'
const deploymentWorkflow = '.github/workflows/cloudflare-app-deploy.yml'
const anchorName = '_mikka-release.aspectlylabs.com'
const anchorUrl = 'https://cloudflare-dns.com/dns-query?name=' + anchorName + '&type=TXT'
const receiptFields = ['schema', 'approvalComment', 'approvalSha256', 'product', 'overlay', 'releasePin',
  'gatewayVersionSha256', 'inventorySha256', 'verifiedAt', 'outcome']
const sha = /^[0-9a-f]{40}$/
const hash = /^[0-9a-f]{64}$/
const decimal = /^[1-9][0-9]*$/
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex')
const present = (value, pattern) => typeof value === 'string' && pattern.test(value)
const requireProof = (ok, code) => { if (!ok) throw Error('cloudflareWeb:' + code) }

async function readOwnerBody(id, bodyHash, prefix, api) {
  const row = await githubRead('/issues/comments/' + id, api)
  const owner = ownerIssue.exec(row.issue_url ?? '')?.[1]
  requireProof(String(row.id) === id && owner && row.user?.id === ownerId
    && row.user.login === 'alexj11324' && (row.author_association === 'OWNER'
      || owner === 'aspectly-labs' && row.author_association === 'MEMBER'), 'ownerComment')
  requireProof(typeof row.body === 'string' && digest(row.body) === bodyHash && row.body.startsWith(prefix), 'commentChanged')
  return row.body.slice(prefix.length)
}

export function parsePromotionRecord(raw) {
  const record = JSON.parse(raw)
  requireProof(record && Object.keys(record).join('|') === receiptFields.join('|') && JSON.stringify(record) === raw
    && record.schema === 'mikka.cloudflare-promotion.v1' && record.outcome === 'promoted', 'receiptShape')
  requireProof(present(record.approvalComment, decimal) && [record.product, record.overlay].every(v => present(v, sha))
    && [record.gatewayVersionSha256, record.inventorySha256, record.approvalSha256].every(v => present(v, hash)), 'receiptIdentity')
  requireProof(isValidDeploymentId(record.releasePin) && /^[0-9a-f]{7,12}-[1-9][0-9]*-[1-9][0-9]*$/.test(record.releasePin)
    && record.product.startsWith(record.releasePin.split('-')[0]), 'clientPin')
  const verified = Date.parse(record.verifiedAt)
  requireProof(Number.isFinite(verified) && new Date(verified).toISOString() === record.verifiedAt, 'verificationTime')
  return record
}

async function publicRead(url, accept, fetchImpl) {
  const response = await fetchImpl(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000),
    headers: { accept, 'cache-control': 'no-cache' } })
  requireProof(response.status === 200, 'publicUnavailable')
  return response
}

// The original publisher may use its Vercel credentials only while the public app
// and release DNS agree it is still the active origin. An incomplete cutover fails closed.
export async function readWebAuthority(fetchImpl = fetch) {
  const [dns, version] = await Promise.all([
    publicRead(anchorUrl, 'application/dns-json', fetchImpl).then(response => response.json()),
    publicRead(PRODUCTION_VERSION_URL, 'application/json', fetchImpl),
  ])
  const answers = dns.Answer ?? []
  const name = value => value?.replace(/\.$/, '').toLowerCase()
  requireProof(!dns.TC && Array.isArray(answers) && dns.Question?.length === 1
    && name(dns.Question[0].name) === anchorName && dns.Question[0].type === 16, 'dnsAuthority')
  const { build } = await version.json()
  requireProof(present(build, sha), 'productionSource')
  const gateway = version.headers.get('x-mikka-gateway-version-sha256')
  if ([0, 3].includes(dns.Status) && answers.length === 0 && version.headers.get('x-vercel-id') && !gateway) {
    return { provider: 'vercel', sha: build }
  }
  const absent = [0, 3].includes(dns.Status) && answers.length === 0
  const historical = dns.Status === 0 && answers.length === 1 && name(answers[0].name) === anchorName
    && answers[0].type === 16 && /^"mikka-release-v1=sha256:[a-f0-9]{64}"$/.test(answers[0].data)
  requireProof((absent || historical) && !version.headers.has('x-vercel-id')
    && version.headers.has('cf-ray') && present(gateway, hash), 'originUnconfirmed')
  return { provider: 'cloudflare', sha: build }
}

async function liveProof(record, raw, fetchImpl) {
  const [dns] = await Promise.all([
    publicRead(anchorUrl, 'application/dns-json', fetchImpl).then(r => r.json()),
    liveServingRelease(record, fetchImpl),
  ])
  const answers = dns.Answer
  requireProof(dns.Status === 0 && !dns.TC && Array.isArray(answers) && answers.length === 1 && answers[0].type === 16
    && answers[0].name?.replace(/\.$/, '').toLowerCase() === anchorName
    && answers[0].data === '"mikka-release-v1=sha256:' + digest(raw) + '"', 'dnsAnchor')
}

async function liveServingRelease(record, fetchImpl) {
  const [version, shell] = await Promise.all([
    publicRead(PRODUCTION_VERSION_URL, 'application/json', fetchImpl),
    publicRead(new URL('/mikka/en/sign-in', PRODUCTION_VERSION_URL).href, 'text/html', fetchImpl),
  ])
  requireProof(!version.headers.has('x-vercel-id') && version.headers.has('cf-ray')
    && version.headers.get('x-mikka-gateway-version-sha256') === record.gatewayVersionSha256, 'gatewayVersion')
  const body = await version.json()
  requireProof(body.build === record.product && body.overlaySha === record.overlay, 'productionSource')
  const script = (await shell.text()).match(/<script[^>]*\bsrc=["'](\/mikka\/assets\/[^"']+)["']/i)
  const url = script && new URL(script[1].replaceAll('&amp;', '&'), PRODUCTION_VERSION_URL)
  requireProof(url && /^\/mikka\/assets\/[A-Za-z0-9_.-]+\.js$/.test(url.pathname)
    && url.searchParams.getAll('dpl').length === 1 && url.searchParams.get('dpl') === record.releasePin, 'servedClientPin')
}

// The protected gateway observer publishes four non-secret identifiers in a
// terminal job name. GitHub scopes job metadata to the exact original attempt.
const observationRef = /^actions:([1-9][0-9]{0,15}):([1-9][0-9]{0,15})$/
async function servingObservation(ref, api) {
  const [, runId, attempt] = ref
  const path = '/actions/runs/' + runId + '/attempts/' + attempt
  const [run, listing] = await Promise.all([githubRead(path, api), githubRead(path + '/jobs?per_page=100', api)])
  requireProof([run.repository, run.head_repository].every(r => officialRepository(r) && r.fork === false)
    && run.path === '.github/workflows/cloudflare-app-deploy.yml' && run.head_branch === 'main' && present(run.head_sha, sha)
    && run.event === 'workflow_dispatch' && run.status === 'completed' && run.conclusion === 'success'
    && run.actor?.id === ownerId && run.triggering_actor?.id === ownerId
    && String(run.id) === runId && String(run.run_attempt) === attempt, 'observationRun')
  requireProof(Array.isArray(listing.jobs) && listing.total_count === listing.jobs.length, 'observationJobs')
  const completed = job => job.status === 'completed' && job.conclusion === 'success' && job.head_sha === run.head_sha
    && String(job.run_id) === runId && String(job.run_attempt) === attempt
  const jobs = listing.jobs.filter(job => job.name?.startsWith('Serving release '))
  const drivers = listing.jobs.filter(job => job.name === 'deploy-application')
  requireProof(jobs.length === 1 && drivers.length === 1 && completed(jobs[0]) && completed(drivers[0]), 'observationJobs')
  const fields = /^Serving release ([a-f0-9]{40}) ([a-f0-9]{40}) ([a-f0-9]{7,12}-[1-9][0-9]*-[1-9][0-9]*) ([a-f0-9]{64})$/.exec(jobs[0].name)
  requireProof(fields && fields[1].startsWith(fields[3].split('-')[0]) && isValidDeploymentId(fields[3]), 'observationIdentity')
  requireProof(Number.isFinite(Date.parse(jobs[0].completed_at)), 'observationTime')
  return { product: fields[1], overlay: fields[2], releasePin: fields[3], gatewayVersionSha256: fields[4], verifiedAt: jobs[0].completed_at }
}

/** Re-read the original release decision at its issuance and the currently
 * served gateway, shell and DNS. This read-only check grants no release rights. */
export async function readServingPromotion(pin, {token, fetchImpl=fetch, now=Date.now()}={}) {
  const observed = observationRef.exec(pin)
  if (observed) {
    const record = await servingObservation(observed, { token, fetchImpl })
    await liveServingRelease(record, fetchImpl)
    return record
  }
  const match=/^([1-9][0-9]{0,15})-([a-f0-9]{64})$/.exec(pin)
  requireProof(match,'ownerComment')
  const api={token,fetchImpl}
  const raw=await readOwnerBody(match[1],match[2],'MIKKA_CLOUDFLARE_WEB_PROMOTION_V1\n',api)
  const record=parsePromotionRecord(raw)
  const approvalBody=await readOwnerBody(record.approvalComment,record.approvalSha256,'MIKKA_CUTOVER_ACCEPTANCE_V1',api)
  requireProof(/^\r?\n/.test(approvalBody),'approvalMarker')
  const approval=JSON.parse(approvalBody),issued=Date.parse(record.verifiedAt)
  requireProof(record.approvalComment!==match[1] && approval.decision==='approved' && approval.product===record.product &&
    approval.overlay===record.overlay && approval.evidence?.inventoryAndRollback?.sha256===record.inventorySha256 &&
    /^https:\/\/github\.com\/alexj11324\/mikka-cloud\/issues\/4#issuecomment-[1-9][0-9]*$/.test(approval.evidence.inventoryAndRollback.url) &&
    Date.parse(approval.from)<=issued && issued<Date.parse(approval.until) && issued<=now,'approval')
  await liveProof(record,raw,fetchImpl)
  return record
}

export function verifyPromotedWeb(options) {
  return verifyPromotion(runtimeWorkflow, options)
}

export function verifyDesktopPromotedWeb(options) {
  return verifyPromotion(desktopWorkflow, options)
}

async function verifyPromotion(workflow, { env = process.env, event, fetchImpl = fetch, now = Date.now } = {}) {
  const pin = /^([1-9][0-9]*)-([a-f0-9]{64})$/.exec(env.CLOUDFLARE_RECEIPT ?? '')
  const observed = observationRef.exec(env.CLOUDFLARE_RECEIPT ?? '')
  // A consumer started by the observation itself (workflow_run) may only use that
  // exact observation; a historical owner receipt still needs a manual dispatch.
  const chained = env.GITHUB_EVENT_NAME === 'workflow_run'
  requireProof((pin || observed) && actionsMikkaRepository(env) && env.GITHUB_REF === 'refs/heads/main'
    && (env.GITHUB_EVENT_NAME === 'workflow_dispatch' || chained && observed) && present(env.GITHUB_SHA, sha)
    && present(env.GITHUB_RUN_ID, decimal) && present(env.GITHUB_RUN_ATTEMPT, decimal), 'dispatch')
  if (chained) {
    const source = (event ?? await readEvent(env)).workflow_run
    requireProof(String(source?.id) === observed[1] && String(source?.run_attempt) === observed[2]
      && source.path === deploymentWorkflow, 'dispatchSource')
  }
  const api = { token: env.GITHUB_TOKEN, fetchImpl }
  let record, raw, until, approval
  if (observed) {
    record = await servingObservation(observed, api)
  } else {
    raw = await readOwnerBody(pin[1], pin[2], 'MIKKA_CLOUDFLARE_WEB_PROMOTION_V1\n', api)
    record = parsePromotionRecord(raw)
    requireProof(record.approvalComment !== pin[1], 'dispatchSource')
  }
  // The runtime release publishes the worker of the commit Cloudflare serves. A
  // dispatch on a later main builds that served commit (MIKKA_RUNTIME_SOURCE once
  // chosen); it never builds HEAD in its place.
  const runtimeSource = env.MIKKA_RUNTIME_SOURCE || record.product
  requireProof(workflow === desktopWorkflow ? true : record.product === runtimeSource
    && (record.product === env.GITHUB_SHA || !chained), 'dispatchSource')
  const run = await githubRead('/actions/runs/' + env.GITHUB_RUN_ID + '/attempts/' + env.GITHUB_RUN_ATTEMPT, api)
  requireProof(officialRepository(run.repository) === env.GITHUB_REPOSITORY && run.event === (chained ? 'workflow_run' : 'workflow_dispatch') && run.path === workflow
    && run.head_sha === env.GITHUB_SHA && run.head_branch === 'main' && String(run.id) === env.GITHUB_RUN_ID
    && String(run.run_attempt) === env.GITHUB_RUN_ATTEMPT, 'runIdentity')
  if (observed) {
    requireProof(run.actor?.id === ownerId && run.triggering_actor?.id === ownerId, 'dispatchActor')
  } else {
    const approvalBody = await readOwnerBody(record.approvalComment, record.approvalSha256, 'MIKKA_CUTOVER_ACCEPTANCE_V1', api)
    requireProof(/^\r?\n/.test(approvalBody), 'approvalMarker')
    approval = JSON.parse(approvalBody)
    const inventory = approval.evidence?.inventoryAndRollback
    requireProof(approval.decision === 'approved' && approval.product === record.product && approval.overlay === record.overlay
      && inventory?.sha256 === record.inventorySha256
      && /^https:\/\/github\.com\/alexj11324\/mikka-cloud\/issues\/4#issuecomment-[1-9][0-9]*$/.test(inventory?.url), 'approval')
    const verified = Date.parse(record.verifiedAt), started = Date.parse(run.run_started_at)
    // GitHub timestamps are second-precision. Bind freshness to this original attempt so
    // a long native validation can finish without accepting a new dispatch on an old anchor.
    requireProof(started >= Math.floor(verified / 1000) * 1000 && started <= verified + 600_000
      && started <= now() && verified <= now(), 'staleDispatch')
    const from = Date.parse(approval.from)
    until = Date.parse(approval.until)
    requireProof(from <= verified && now() < until, 'approvalWindow')
  }
  if (workflow === desktopWorkflow) {
    const expectedOverlay = env.MIKKA_UI_OVERLAY_SHA || env.EXPECTED_UI_OVERLAY_SHA
    requireProof(!expectedOverlay || expectedOverlay === record.overlay, 'desktopOverlay')
    // The installer is built from the served commit (MIKKA_DESKTOP_SOURCE once checked out), never from a later main.
    const desktopSource = env.MIKKA_DESKTOP_SOURCE || record.product
    requireProof(present(desktopSource, sha) && await containsDesktopSource({ ...api, expectedBuild: desktopSource, publicCommit: record.product }), 'desktopSource')
  }
  if (observed) await liveServingRelease(record, fetchImpl)
  else await liveProof(record, raw, fetchImpl)
  // Desktop and the runtime publish the served commit; it must already be part of main.
  // Later merges to main neither replace it nor block its publication.
  requireProof(await servedOnMain(record.product, api), 'servedOnMain')
  if (!observed) requireProof(now() < until, 'approvalWindow')
  const result = { product: record.product, releasePin: record.releasePin }
  return workflow === desktopWorkflow ? { ...result, overlay: record.overlay } : result
}

async function servedOnMain(product, api) {
  const compared = await githubRead('/compare/' + product + '...main', api)
  return (compared.status === 'identical' || compared.status === 'ahead') && compared.merge_base_commit?.sha === product
}

async function readEvent(env) {
  try { return JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')) } catch (cause) { throw Error('cloudflareWeb:event', { cause }) }
}

/** Decide whether a finished Cloudflare deployment run should start a consumer release.
 * Only a successful gateway observation whose served product is current main (and the
 * commit this consumer run checked out) qualifies; anything else is a quiet no-op. */
export async function promotionTrigger(consumer, { env = process.env, event, fetchImpl = fetch } = {}) {
  requireProof([runtimeWorkflow, desktopWorkflow].includes(consumer), 'consumer')
  const source = (event ?? await readEvent(env)).workflow_run
  const api = { token: env.GITHUB_TOKEN, fetchImpl }
  if (!actionsMikkaRepository(env) || env.GITHUB_EVENT_NAME !== 'workflow_run' || source?.path !== deploymentWorkflow || source.event !== 'workflow_dispatch'
    || source.status !== 'completed' || source.conclusion !== 'success' || source.head_branch !== 'main'
    || !officialRepository(source.repository) || !present(String(source.id), decimal) || !present(String(source.run_attempt), decimal)) {
    return { ready: false, reason: 'not a successful Cloudflare deployment run on main' }
  }
  const path = '/actions/runs/' + source.id + '/attempts/' + source.run_attempt + '/jobs?per_page=100'
  const listing = await githubRead(path, api)
  // Every deployment run lists the Serving release job; only gateway-observe runs it (the others skip it, unnamed).
  if (!Array.isArray(listing.jobs) || !listing.jobs.some(job => job.name?.startsWith('Serving release ') && job.conclusion === 'success')) {
    return { ready: false, reason: 'this deployment phase does not change what is served' }
  }
  const receipt = 'actions:' + source.id + ':' + source.run_attempt
  const record = await readServingPromotion(receipt, { token: env.GITHUB_TOKEN, fetchImpl })
  const main = await githubRead('/git/ref/heads/main', api)
  requireProof(main.object?.type === 'commit' && present(main.object.sha, sha), 'mainRef')
  if (consumer === desktopWorkflow ? !await servedOnMain(record.product, api) : record.product !== main.object.sha || record.product !== env.GITHUB_SHA) {
    return { ready: false, reason: 'Cloudflare serves ' + record.product + ' but main is ' + main.object.sha }
  }
  if (consumer === desktopWorkflow) {
    const latest = await githubRead('/releases/latest', api).catch(() => null)
    if (latest?.target_commitish === record.product) return { ready: false, reason: 'Desktop for ' + record.product + ' is already released' }
  }
  return { ready: true, receipt, product: record.product, reason: 'Cloudflare serves ' + record.product + ' on main' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === 'trigger') {
      requireProof(process.argv.length === 4 && ['runtime', 'desktop'].includes(process.argv[3]), 'consumer')
      const result = await promotionTrigger(process.argv[3] === 'desktop' ? desktopWorkflow : runtimeWorkflow)
      console.log(result.reason)
      if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
        `ready=${result.ready}\nreceipt=${result.ready ? result.receipt : ''}\nproduct=${result.ready ? result.product : ''}\n`)
      if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
        `\n### ${result.ready ? 'Released after the Cloudflare promotion' : 'Nothing to release'}\n\n${result.reason}\n`)
    } else if (process.argv.length === 2) {
      const { product } = await verifyPromotedWeb()
      if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `source=${product}\n`)
    }
    else {
      requireProof(process.argv.length === 3 && process.argv[2] === 'desktop', 'consumer')
      const { overlay, product } = await verifyDesktopPromotedWeb()
      if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `overlay-sha=${overlay}\nproduct=${product}\n`)
    }
  } catch (error) {
    console.error(/^cloudflareWeb:[A-Za-z]+$/.test(error?.message) ? error.message : 'cloudflareWeb:unverified')
    process.exitCode = 1
  }
}
