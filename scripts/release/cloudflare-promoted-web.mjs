import { appendFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { isValidDeploymentId } from '../../lib/deployment-id.mjs'
import { assertCurrentMain, containsDesktopSource, githubRead, PRODUCTION_VERSION_URL } from './web-deploy.mjs'

const repository = 'alexj11324/Mikka'
const ownerId = 183887963
const issue = 'https://api.github.com/repos/' + repository + '/issues/1954'
const runtimeWorkflow = '.github/workflows/e2b-official-runtime.yml'
const desktopWorkflow = '.github/workflows/desktop-release.yml'
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
  requireProof(String(row.id) === id && row.issue_url === issue && row.user?.id === ownerId
    && row.user.login === 'alexj11324' && row.author_association === 'OWNER', 'ownerComment')
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
  requireProof(dns.Status === 0 && answers.length === 1 && name(answers[0].name) === anchorName
    && answers[0].type === 16 && /^"mikka-release-v1=sha256:[a-f0-9]{64}"$/.test(answers[0].data)
    && !version.headers.has('x-vercel-id') && version.headers.has('cf-ray') && present(gateway, hash), 'originUnconfirmed')
  return { provider: 'cloudflare', sha: build }
}

async function liveProof(record, raw, fetchImpl) {
  const [dns, version, shell] = await Promise.all([
    publicRead(anchorUrl, 'application/dns-json', fetchImpl).then(r => r.json()),
    publicRead(PRODUCTION_VERSION_URL, 'application/json', fetchImpl),
    publicRead(new URL('/mikka/en/sign-in', PRODUCTION_VERSION_URL).href, 'text/html', fetchImpl),
  ])
  const answers = dns.Answer
  requireProof(dns.Status === 0 && !dns.TC && Array.isArray(answers) && answers.length === 1 && answers[0].type === 16
    && answers[0].name?.replace(/\.$/, '').toLowerCase() === anchorName
    && answers[0].data === '"mikka-release-v1=sha256:' + digest(raw) + '"', 'dnsAnchor')
  requireProof(!version.headers.has('x-vercel-id') && version.headers.has('cf-ray')
    && version.headers.get('x-mikka-gateway-version-sha256') === record.gatewayVersionSha256, 'gatewayVersion')
  const body = await version.json()
  requireProof(body.build === record.product && body.overlaySha === record.overlay, 'productionSource')
  const script = (await shell.text()).match(/<script[^>]*\bsrc=["'](\/mikka\/assets\/[^"']+)["']/i)
  const url = script && new URL(script[1].replaceAll('&amp;', '&'), PRODUCTION_VERSION_URL)
  requireProof(url && /^\/mikka\/assets\/[A-Za-z0-9_.-]+\.js$/.test(url.pathname)
    && url.searchParams.getAll('dpl').length === 1 && url.searchParams.get('dpl') === record.releasePin, 'servedClientPin')
}

/** Re-read the original release decision at its issuance and the currently
 * served gateway, shell and DNS. This read-only check grants no release rights. */
export async function readServingPromotion(pin, {token, fetchImpl=fetch, now=Date.now()}={}) {
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

async function verifyPromotion(workflow, { env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  const pin = /^([1-9][0-9]*)-([a-f0-9]{64})$/.exec(env.CLOUDFLARE_RECEIPT ?? '')
  requireProof(pin && env.GITHUB_REPOSITORY === repository && env.GITHUB_REF === 'refs/heads/main'
    && env.GITHUB_EVENT_NAME === 'workflow_dispatch' && present(env.GITHUB_SHA, sha)
    && present(env.GITHUB_RUN_ID, decimal) && present(env.GITHUB_RUN_ATTEMPT, decimal), 'dispatch')
  const api = { token: env.GITHUB_TOKEN, fetchImpl }
  const raw = await readOwnerBody(pin[1], pin[2], 'MIKKA_CLOUDFLARE_WEB_PROMOTION_V1\n', api)
  const record = parsePromotionRecord(raw)
  requireProof(record.approvalComment !== pin[1] && (workflow === desktopWorkflow || record.product === env.GITHUB_SHA), 'dispatchSource')
  const [approvalBody, run] = await Promise.all([
    readOwnerBody(record.approvalComment, record.approvalSha256, 'MIKKA_CUTOVER_ACCEPTANCE_V1', api),
    githubRead('/actions/runs/' + env.GITHUB_RUN_ID + '/attempts/' + env.GITHUB_RUN_ATTEMPT, api),
  ])
  requireProof(/^\r?\n/.test(approvalBody), 'approvalMarker')
  const approval = JSON.parse(approvalBody)
  const inventory = approval.evidence?.inventoryAndRollback
  requireProof(approval.decision === 'approved' && approval.product === record.product && approval.overlay === record.overlay
    && inventory?.sha256 === record.inventorySha256
    && /^https:\/\/github\.com\/alexj11324\/mikka-cloud\/issues\/4#issuecomment-[1-9][0-9]*$/.test(inventory?.url), 'approval')
  requireProof(run.repository?.full_name === repository && run.event === 'workflow_dispatch' && run.path === workflow
    && run.head_sha === env.GITHUB_SHA && run.head_branch === 'main' && String(run.id) === env.GITHUB_RUN_ID
    && String(run.run_attempt) === env.GITHUB_RUN_ATTEMPT, 'runIdentity')
  const verified = Date.parse(record.verifiedAt), started = Date.parse(run.run_started_at)
  // GitHub timestamps are second-precision. Bind freshness to this original attempt so
  // a long native validation can finish without accepting a new dispatch on an old anchor.
  requireProof(started >= Math.floor(verified / 1000) * 1000 && started <= verified + 600_000
    && started <= now() && verified <= now(), 'staleDispatch')
  const from = Date.parse(approval.from), until = Date.parse(approval.until)
  requireProof(from <= verified && now() < until, 'approvalWindow')
  if (workflow === desktopWorkflow) {
    const expectedOverlay = env.MIKKA_UI_OVERLAY_SHA || env.EXPECTED_UI_OVERLAY_SHA
    requireProof(!expectedOverlay || expectedOverlay === record.overlay, 'desktopOverlay')
    requireProof(await containsDesktopSource({ ...api, expectedBuild: env.GITHUB_SHA, publicCommit: record.product }), 'desktopSource')
  }
  await liveProof(record, raw, fetchImpl)
  await assertCurrentMain({ ...api, expectedBuild: record.product })
  requireProof(now() < until, 'approvalWindow')
  const result = { product: record.product, releasePin: record.releasePin }
  return workflow === desktopWorkflow ? { ...result, overlay: record.overlay } : result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length === 2) await verifyPromotedWeb()
    else {
      requireProof(process.argv.length === 3 && process.argv[2] === 'desktop', 'consumer')
      const { overlay } = await verifyDesktopPromotedWeb()
      if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `overlay-sha=${overlay}\n`)
    }
  } catch (error) {
    console.error(/^cloudflareWeb:[A-Za-z]+$/.test(error?.message) ? error.message : 'cloudflareWeb:unverified')
    process.exitCode = 1
  }
}
