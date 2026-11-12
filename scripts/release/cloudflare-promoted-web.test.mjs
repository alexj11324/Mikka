import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { verifyPromotedWeb, verifyDesktopPromotedWeb, readServingPromotion } from './cloudflare-promoted-web.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')
const product = 'abc1234'.padEnd(40, '5'), overlay = 'c'.repeat(40), releasePin = 'abc1234-902-1'
const verified = Date.parse('2026-11-10T10:00:00.100Z')
const iso = offset => new Date(verified + offset).toISOString()
const repo = 'alexj11324/Mikka', issue = 'https://api.github.com/repos/' + repo + '/issues/1954'
const workflow = '.github/workflows/e2b-official-runtime.yml'

function fixture(change = {}) {
  const inventory = { url: 'https://github.com/alexj11324/mikka-cloud/issues/4#issuecomment-901', sha256: 'd'.repeat(64) }
  const approval = { product, overlay, from: iso(-1000), until: iso(3 * 3600_000), decision: 'approved',
    evidence: { inventoryAndRollback: inventory }, ...change.approval }
  const owner = { issue_url: issue, user: { id: 183887963, login: 'alexj11324' }, author_association: 'OWNER' }
  const prior = { ...owner, id: 80, body: 'MIKKA_CUTOVER_ACCEPTANCE_V1\r\n' + JSON.stringify(approval), ...change.prior }
  const record = { schema: 'mikka.cloudflare-promotion.v1', approvalComment: '80', approvalSha256: digest(prior.body), product,
    overlay, releasePin, gatewayVersionSha256: 'e'.repeat(64), inventorySha256: 'd'.repeat(64), verifiedAt: iso(0),
    outcome: 'promoted', ...change.record }
  const raw = change.raw?.(record) ?? JSON.stringify(record)
  const post = { ...owner, id: 81, body: 'MIKKA_CLOUDFLARE_WEB_PROMOTION_V1\n' + raw, ...change.post }
  const env = { GITHUB_REPOSITORY: repo, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: product,
    GITHUB_RUN_ID: '55', GITHUB_RUN_ATTEMPT: '2', GITHUB_TOKEN: 'test', CLOUDFLARE_RECEIPT: '81-' + digest(post.body), ...change.env }
  const started = { repository: { full_name: repo }, event: 'workflow_dispatch', path: workflow, head_sha: product, head_branch: 'main',
    id: 55, run_attempt: 2, run_started_at: iso(30000), ...change.run }
  const anchor = { name: '_mikka-release.aspectlylabs.com.', type: 16, data: '"mikka-release-v1=sha256:' + digest(raw) + '"' }
  const calls = []
  const fetchImpl = async (url, options) => {
    const u = new URL(url)
    calls.push(u.pathname)
    assert.equal(options.redirect, 'error')
    assert.equal(options.cache, 'no-store')
    if (u.origin === 'https://api.github.com') {
      assert.equal(options.headers.authorization, 'Bearer test')
      if (u.pathname.includes('/compare/')) {
        const path = '/repos/' + repo + '/compare/' + env.GITHUB_SHA + '...' + product
        assert.equal(u.pathname, path)
        assert.equal(u.searchParams.get('per_page'), '1')
        return Response.json({ url: 'https://api.github.com' + path, base_commit: { sha: env.GITHUB_SHA },
          merge_base_commit: { sha: env.GITHUB_SHA }, status: 'ahead', ahead_by: 1, behind_by: 0, ...change.comparison })
      }
      const body = { ['/repos/' + repo + '/issues/comments/81']: post, ['/repos/' + repo + '/issues/comments/80']: prior,
        ['/repos/' + repo + '/actions/runs/55/attempts/2']: started,
        ['/repos/' + repo + '/git/ref/heads/main']: { object: { type: 'commit', sha: change.main ?? product } } }[u.pathname]
      assert.ok(body, u.pathname)
      return Response.json(body)
    }
    assert.equal(options.headers.authorization, undefined)
    if (u.hostname === 'cloudflare-dns.com') {
      assert.equal(options.headers.accept, 'application/dns-json')
      assert.equal(u.search, '?name=_mikka-release.aspectlylabs.com&type=TXT')
      return Response.json({ Status: 0, TC: false, Answer: [anchor], ...change.dns?.(anchor) })
    }
    assert.equal(u.origin, 'https://app.aspectlylabs.com')
    if (u.pathname === '/mikka/api/version') return Response.json({ build: product, overlaySha: overlay, ...change.version }, {
      headers: { 'cf-ray': 'edge', 'x-mikka-gateway-version-sha256': record.gatewayVersionSha256, ...change.headers } })
    assert.equal(u.pathname, '/mikka/en/sign-in')
    return new Response(change.shell ?? '<script type="module" src="/mikka/assets/entry-123.js?dpl=' + releasePin + '"></script>')
  }
  const options = { env, fetchImpl, now: () => verified + (change.elapsed ?? 3600000) }
  return { verify: () => verifyPromotedWeb(options), desktop: () => verifyDesktopPromotedWeb(options),
    observe: () => readServingPromotion(env.CLOUDFLARE_RECEIPT,{token:env.GITHUB_TOKEN,fetchImpl,now:options.now()}),calls }
}

test('revalidates the live promoted Web on the original dispatch after 3976 seconds of native work', async () => {
  for (const elapsed of [60000, 3976000]) {
    const f = fixture({ elapsed })
    assert.deepEqual(await f.verify(), { product, releasePin })
    assert.equal(f.calls.length, 7)
    assert.equal(f.calls.at(-1), '/repos/' + repo + '/git/ref/heads/main')
  }
})
test('rejects dispatch, owner, hash, inventory, timing and current-main changes', async () => {
  for (const [change, code] of [
    [{ env: { GITHUB_EVENT_NAME: 'push' } }, 'dispatch'],
    [{ env: { CLOUDFLARE_RECEIPT: '81-' + 'f'.repeat(64) } }, 'commentChanged'],
    [{ post: { issue_url: issue + '0' } }, 'ownerComment'],
    [{ prior: { author_association: 'MEMBER' } }, 'ownerComment'],
    [{ post: { user: { id: 1, login: 'alexj11324' } } }, 'ownerComment'],
    [{ record: { approvalSha256: 'f'.repeat(64) } }, 'commentChanged'],
    [{ record: { product: 'b'.repeat(40), releasePin: 'bbbbbbb-902-1' } }, 'dispatchSource'],
    [{ record: { releasePin: 'abc1234-x-1' } }, 'clientPin'],
    [{ raw: record => JSON.stringify(record, null, 2) }, 'receiptShape'],
    [{ raw: record => JSON.stringify({ ...record, privateMapping: 'extra' }) }, 'receiptShape'],
    [{ record: { outcome: 'rolled-back' } }, 'receiptShape'],
    [{ record: { verifiedAt: '2026-11-10' } }, 'verificationTime'],
    [{ record: { inventorySha256: 'f'.repeat(64) } }, 'approval'],
    [{ approval: { decision: 'denied' } }, 'approval'],
    [{ approval: { overlay: 'f'.repeat(40) } }, 'approval'],
    [{ approval: { evidence: {} } }, 'approval'],
    [{ run: { path: '.github/workflows/other.yml' } }, 'runIdentity'],
    [{ run: { run_attempt: 1 } }, 'runIdentity'],
    [{ run: { run_started_at: iso(600001) } }, 'staleDispatch'],
    [{ run: { run_started_at: iso(-30000) } }, 'staleDispatch'],
    [{ elapsed: 3 * 3600_000 }, 'approvalWindow'],
    [{ main: 'f'.repeat(40) }, 'mainChanged'],
  ]) await assert.rejects(fixture(change).verify(), new RegExp(code), code)
})
test('rejects stale DNS, rollback, a legacy gateway serving the same SHA, and client skew', async () => {
  for (const [change, code] of [
    [{ dns: () => ({ Status: 3, Answer: [] }) }, 'dnsAnchor'],
    [{ dns: a => ({ Answer: [a, a] }) }, 'dnsAnchor'],
    [{ dns: a => ({ Answer: [{ ...a, name: 'other.example.' }] }) }, 'dnsAnchor'],
    [{ dns: a => ({ Answer: [{ ...a, data: '"prior"' }] }) }, 'dnsAnchor'],
    [{ dns: () => ({ TC: true }) }, 'dnsAnchor'],
    [{ headers: { 'x-vercel-id': 'same-source' } }, 'gatewayVersion'],
    [{ headers: { 'x-mikka-gateway-version-sha256': '0'.repeat(64) } }, 'gatewayVersion'],
    [{ version: { overlaySha: 'a'.repeat(40) } }, 'productionSource'],
    [{ shell: '<script src="/mikka/assets/current.js?dpl=old"></script>' }, 'servedClientPin'],
    [{ shell: '<script src="/mikka/assets/current.js?dpl=' + releasePin + '&amp;dpl=old"></script>' }, 'servedClientPin'],
  ]) await assert.rejects(fixture(change).verify(), new RegExp(code), code)
})
test('Desktop binds its own original attempt, installer ancestry, overlay and serving gateway before publication', async () => {
  const installer = '9'.repeat(40)
  const run = { path: '.github/workflows/desktop-release.yml', head_sha: installer }
  const env = { GITHUB_SHA: installer, MIKKA_UI_OVERLAY_SHA: overlay }
  const good = fixture({ env, run, elapsed: 5400000 })
  assert.deepEqual(await good.desktop(), { product, releasePin, overlay })
  assert.ok(good.calls.some(path => path.includes('/compare/')))
  await assert.rejects(good.verify(), /dispatchSource/)
  const exact = fixture({ run: { ...run, head_sha: product } })
  assert.deepEqual(await exact.desktop(), { product, releasePin, overlay })
  assert.ok(!exact.calls.some(path => path.includes('/compare/')))
  for (const [change, code] of [
    [{ run: { ...run, path: workflow } }, 'runIdentity'],
    [{ run: { ...run, head_sha: product } }, 'runIdentity'],
    [{ run: { ...run, run_attempt: 3 } }, 'runIdentity'],
    [{ run: { ...run, event: 'push' } }, 'runIdentity'],
    [{ env: { ...env, EXPECTED_UI_OVERLAY_SHA: 'a'.repeat(40), MIKKA_UI_OVERLAY_SHA: '' } }, 'desktopOverlay'],
    [{ env: { ...env, MIKKA_UI_OVERLAY_SHA: 'a'.repeat(40) } }, 'desktopOverlay'],
    [{ comparison: { merge_base_commit: { sha: product }, status: 'diverged', behind_by: 1 } }, 'desktopSource'],
    [{ comparison: { base_commit: { sha: product } } }, 'invalidCommitComparison'],
    [{ main: installer }, 'mainChanged'],
    [{ headers: { 'x-vercel-id': 'old' } }, 'gatewayVersion'],
    [{ elapsed: 4 * 3600000 }, 'approvalWindow'],
  ]) await assert.rejects(fixture({ env, run, ...change }).desktop(), new RegExp(code))
  await assert.rejects(fixture({ run: { path: '.github/workflows/desktop-release.yml' } }).verify(), /runIdentity/)
})

test('both publication modes share the paid builder and subscriptions, while Cloudflare omits the legacy publisher', () => {
  const read = name => readFileSync(new URL('../../.github/workflows/' + name, import.meta.url), 'utf8')
  const parent = read('e2b-official-runtime.yml'), child = read('e2b-runtime-release.yml')
  const gate = 'run: node scripts/release/cloudflare-promoted-web.mjs'
  assert.ok(parent.indexOf(gate) > parent.indexOf('  web-ready:') && parent.indexOf(gate) < parent.indexOf('  release:'))
  const paid = child.indexOf('    uses: ./.github/workflows/e2b-template.yml')
  const proof = child.indexOf('run: node scripts/e2b/validate-template-subscriptions.mjs')
  const first = child.indexOf(gate), second = child.indexOf(gate, first + 1), third = child.indexOf(gate, second + 1)
  assert.ok(first >= 0 && first < paid && paid < second && second < proof && proof < third && third < child.indexOf('--publish-verified'))
  assert.match(child, /id: release[\s\S]*node scripts\/e2b\/runtime-report\.mjs reference\n          node scripts\/release\/cloudflare-promoted-web\.mjs/)
  assert.match(child, /  publish:\n    needs: \[validate, await-web, subscriptions\]\n    if: github\.event\.inputs\.cloudflare_receipt == ''/)
  for (const source of [parent, child]) assert.match(source, /if: github\.event\.inputs\.cloudflare_receipt == ''\n        run: node scripts\/release\/web-deploy\.mjs await-web/)
})

test('read-only monitor witness rechecks an older actual promotion without authorizing publication', async () => {
  const historical=fixture({elapsed:100*86400000})
  assert.equal((await historical.observe()).product,product)
  assert.ok(!historical.calls.some(path=>path.includes('/actions/runs/')))
  await assert.rejects(historical.verify(),/approvalWindow/)
  for(const changed of [{headers:{'x-vercel-id':'old'}},{version:{overlaySha:'1'.repeat(40)}},
    {shell:'<script src="/unrelated.js"></script>'},{approval:{decision:'rejected'}},
    {approval:{until:iso(-10000)}},{post:{author_association:'MEMBER'}}]){
    await assert.rejects(fixture(changed).observe())
  }
})
