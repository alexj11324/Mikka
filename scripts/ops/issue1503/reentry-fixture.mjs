// Issue #1503 only. Pure receipt/metadata checks; importing performs no I/O.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const REENTRY = Object.freeze({
  issue: 1503, workspaceId: '93f38d33-9447-4eaf-8a46-0d8889165bcd',
  teamId: '62a760fc-da79-4d50-a8fa-a818e25d2f9a',
  payerWorkspaceId: 'ed898131-d8ea-4734-8e83-9ee2cdfe9206',
  ownerUserId: 'XjTsvV1ASqtV8wWat9aco0Z0KLodd9jJ',
  smokeUserId: 'cL1NXe1mr7WuIS8xWhU37v0p7kNoUMY3',
  repository: 'alexj11324/Mikka-handoff', githubLogin: 'alexj11324', githubAccountId: '183887963',
  retainedE2bUpdatedAt: '2026-11-06T18:21:51.895Z',
  historicalFixtureSha256: '0da23cbb104014a36e130c82c3ae583f01a16825686da1393fb572bc8b199791',
  releaseProjectionSha256: '2f307f3bff45e80efb55a10952a7a743720b664882e8bfef6d97843abd70702d',
})
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hex = (value, size) => typeof value === 'string' && new RegExp('^[a-f0-9]{' + size + '}$').test(value)
const positiveId = value => typeof value === 'string' && /^[1-9]\d*$/.test(value)
const check = (value, code) => { if (!value) throw new Error('issue1503_reentry_' + code) }
const hash = value => createHash('sha256').update(value).digest('hex')
const timestamp = value => typeof value === 'string' ? Date.parse(value) : NaN
const iso = value => value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null

export function reentryRuntime(env) {
  check(env.NODE_ENV === 'production' && env.VERCEL_ENV === 'production' && env.MIKKA_EDITION === 'cloud', 'production_environment_required')
  check(hex(env.MIKKA_EXPECTED_DEPLOYMENT_SHA, 40) && hex(env.GITHUB_SHA, 40)
    && positiveId(env.GITHUB_RUN_ID) && positiveId(env.GITHUB_RUN_ATTEMPT), 'actual_runtime_binding_required')
  return { expectedAppSha: env.MIKKA_EXPECTED_DEPLOYMENT_SHA, operatorSha: env.GITHUB_SHA,
    marker: env.GITHUB_RUN_ID + '-' + env.GITHUB_RUN_ATTEMPT }
}

// retainedInstallationMatches comes from exact timestamptz equality in the same
// SELECT as this metadata, not a millisecond-rounded JavaScript comparison.
export function reentryE2bObservation(row, setupPerformed) {
  const updatedAt = iso(row?.updatedAt), verifiedAt = iso(row?.verifiedAt)
  check(object(row) && row.userId === REENTRY.smokeUserId && updatedAt && verifiedAt
    && row.lastErrorCode == null && typeof row.updatedAtText === 'string'
    && timestamp(row.updatedAtText) === timestamp(updatedAt) && typeof setupPerformed === 'boolean', 'e2b_metadata_invalid')
  if (!setupPerformed) check(row.retainedInstallationMatches === true
    && updatedAt === REENTRY.retainedE2bUpdatedAt, 'retained_e2b_key_changed')
  return {
    e2bObserved: { userId: row.userId, updatedAt, updatedAtText: row.updatedAtText, verifiedAt,
      lastErrorCode: null, retainedInstallationMatches: row.retainedInstallationMatches === true },
    e2bOwnership: setupPerformed ? { kind: 'new_normal_setup' } : {
      kind: 'retained_original_setup', historicalFixtureSha256: REENTRY.historicalFixtureSha256,
      releaseProjectionSha256: REENTRY.releaseProjectionSha256, originalUpdatedAt: REENTRY.retainedE2bUpdatedAt,
    },
  }
}

function document(bytes, expectedHash, code) {
  check(Buffer.isBuffer(bytes) && hex(expectedHash, 64) && hash(bytes) === expectedHash, code + '_bytes_mismatch')
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { check(false, code + '_json_invalid') }
  check(object(value), code + '_shape_invalid')
  return value
}
function receipt(value, phase, status, binding, now) {
  check(value.issue === REENTRY.issue && value.phase === phase && value.status === status
    && value.workspaceId === REENTRY.workspaceId && value.ownerUserId === REENTRY.ownerUserId
    && value.smokeUserId === REENTRY.smokeUserId && value.productionBuild === binding.appSha
    && value.operatorSha === binding.operatorSha && value.marker === binding.marker
    && Number.isFinite(timestamp(value.startedAt)) && Number.isFinite(timestamp(value.completedAt))
    && timestamp(value.startedAt) <= timestamp(value.completedAt)
    && timestamp(value.completedAt) <= now + 30_000, phase + '_binding_invalid')
}

// Offline only. The caller supplies hashes from the actual original receipt
// reader. No token, credential row, VM or production API is read here.
export function composeReentryFixture(input, now = Date.now()) {
  const { appSha, operatorSha, marker } = input
  check(hex(appSha, 40) && hex(operatorSha, 40) && /^[1-9]\d*-[1-9]\d*$/.test(marker ?? '')
    && Number.isFinite(now), 'actual_source_binding_required')
  const previous = document(input.previousFixtureBytes, REENTRY.historicalFixtureSha256, 'historical_fixture')
  const release = document(input.releaseProjectionBytes, REENTRY.releaseProjectionSha256, 'release_projection')
  const preflight = document(input.preflightBytes, input.preflightSha256, 'preflight')
  const credit = document(input.creditShareBytes, input.creditShareSha256, 'credit_share')
  const binding = { appSha, operatorSha, marker }
  receipt(preflight, 'preflight_reentry', 'prepared', binding, now)
  receipt(credit, 'credit_share_setup', 'passed', binding, now)
  check(release.issue === REENTRY.issue && release.workspaceId === REENTRY.workspaceId
    && release.phase === 'failed_release' && release.acceptancePassed === false
    && release.status === 'completed_with_retained_credentials'
    && release.github?.revoked === true && release.github?.disconnected === true
    && release.retained?.length === 1 && release.retained[0]?.kind === 'e2b_key'
    && release.retained[0]?.reason === 'unrelated_sandbox_still_exists'
    && timestamp(release.completedAt) <= timestamp(preflight.startedAt)
    && timestamp(preflight.completedAt) <= timestamp(credit.startedAt), 'release_or_chronology_mismatch')
  check(previous.issue === REENTRY.issue && previous.workspaceId === REENTRY.workspaceId
    && previous.ownerUserId === REENTRY.ownerUserId && previous.smokeUserId === REENTRY.smokeUserId
    && previous.e2bChanged === true && previous.e2bSetup?.userId === REENTRY.smokeUserId
    && previous.e2bSetup?.updatedAt === REENTRY.retainedE2bUpdatedAt, 'historical_e2b_ownership_mismatch')
  check(preflight.teamId === REENTRY.teamId && preflight.teamIdentifier === 'F1503'
    && preflight.shareBefore?.shared === false && preflight.shareBefore?.allowOthers === false
    && preflight.shareBefore?.allowed === true && preflight.shareAfter?.shared === true
    && preflight.shareAfter?.allowOthers === true && preflight.shareAfter?.allowed === true, 'workspace_setup_mismatch')
  check(credit.setupOnly === true && credit.changed === true && credit.commitUnconfirmed !== true
    && credit.payerWorkspaceId === REENTRY.payerWorkspaceId
    && credit.before?.mine === false && credit.before?.canShare === true
    && credit.after?.mine === true && credit.after?.canShare === true
    && typeof credit.after?.sharedAt === 'string' && Number.isFinite(timestamp(credit.after.sharedAt))
    && credit.sharedPayer?.ownerUserId === REENTRY.ownerUserId && credit.sharedPayer?.verified === true
    && credit.sharedPayer?.positiveBudget === true && credit.sharedPayer?.workspaceId === credit.payerWorkspaceId
    && credit.retry == null, 'credit_share_setup_mismatch')
  const observed = preflight.e2bObserved
  check(preflight.e2bConfigured === true && observed?.userId === REENTRY.smokeUserId
    && Number.isFinite(timestamp(observed.updatedAt)) && Number.isFinite(timestamp(observed.verifiedAt))
    && typeof observed.updatedAtText === 'string' && timestamp(observed.updatedAtText) === timestamp(observed.updatedAt)
    && observed.lastErrorCode === null, 'e2b_observation_mismatch')
  let e2bSetup
  if (preflight.e2bChanged === false) {
    check(preflight.e2bSetup == null && observed.retainedInstallationMatches === true
      && observed.updatedAt === REENTRY.retainedE2bUpdatedAt
      && preflight.e2bOwnership?.kind === 'retained_original_setup'
      && preflight.e2bOwnership.historicalFixtureSha256 === REENTRY.historicalFixtureSha256
      && preflight.e2bOwnership.releaseProjectionSha256 === REENTRY.releaseProjectionSha256
      && preflight.e2bOwnership.originalUpdatedAt === REENTRY.retainedE2bUpdatedAt, 'retained_e2b_provenance_mismatch')
    e2bSetup = { userId: previous.e2bSetup.userId, updatedAt: previous.e2bSetup.updatedAt }
  } else {
    check(preflight.e2bChanged === true && preflight.e2bOwnership?.kind === 'new_normal_setup'
      && preflight.e2bSetup?.userId === REENTRY.smokeUserId && preflight.e2bSetup?.updatedAt === observed.updatedAt
      && timestamp(observed.updatedAt) >= timestamp(preflight.startedAt)
      && timestamp(observed.updatedAt) <= timestamp(preflight.completedAt), 'new_e2b_setup_mismatch')
    e2bSetup = { userId: preflight.e2bSetup.userId, updatedAt: preflight.e2bSetup.updatedAt }
  }
  const gh = preflight.githubSetup
  const githubKeys = ['version','issue','userId','ownerUserId','githubAccountId','githubLogin','repository','appId',
    'repositoryId','installationId','listedRepositoryCount','otherRepositoryMetadataCount','checkTokenScopeConfirmed',
    'providerExpiresAt','connectionExpiresAt','connectionUpdatedAt','tokenSha256']
  check(preflight.githubSetupCreated === true && object(gh)
    && Object.keys(gh).sort().join(',') === [...githubKeys].sort().join(',') && gh.version === 1 && gh.issue === REENTRY.issue
    && gh.userId === REENTRY.smokeUserId && gh.ownerUserId === REENTRY.ownerUserId
    && gh.githubAccountId === REENTRY.githubAccountId && gh.githubLogin === REENTRY.githubLogin
    && gh.repository === REENTRY.repository && ['appId','repositoryId','installationId'].every(key => positiveId(gh[key]))
    && hex(gh.tokenSha256, 64) && gh.tokenSha256 !== previous.githubSetup?.tokenSha256
    && typeof gh.checkTokenScopeConfirmed === 'boolean' && Number.isInteger(gh.listedRepositoryCount) && gh.listedRepositoryCount >= 1
    && timestamp(gh.connectionUpdatedAt) >= timestamp(preflight.startedAt)
    && timestamp(gh.connectionUpdatedAt) <= timestamp(preflight.completedAt)
    && timestamp(gh.connectionExpiresAt) <= timestamp(gh.providerExpiresAt)
    && Math.min(timestamp(gh.connectionExpiresAt), timestamp(gh.providerExpiresAt)) - now >= 100 * 60_000
    && preflight.github?.connected === true && preflight.github.viewerId === REENTRY.smokeUserId
    && preflight.github.login === REENTRY.githubLogin && preflight.github.handoffAccessible === true, 'fresh_github_child_mismatch')
  const fixture = { issue: REENTRY.issue, workspaceId: REENTRY.workspaceId, ownerUserId: REENTRY.ownerUserId,
    smokeUserId: REENTRY.smokeUserId, shareBefore: { ...preflight.shareBefore },
    // This means the retained installation still belongs to this issue's setup.
    // The actual preflight separately records e2bChanged=false for a reused key.
    e2bChanged: true, e2bSetup, githubSetup: { ...gh } }
  const fixtureBytes = Buffer.from(JSON.stringify(fixture, null, 2) + '\n')
  const admission = { issue: REENTRY.issue, phase: 'reentry_fixture_composition', status: 'prepared',
    acceptancePassed: false, appSha, operatorSha, marker, workspaceId: REENTRY.workspaceId,
    historicalFixtureUsedOnlyForE2bOwnership: true, revokedGithubChildReused: false,
    e2bSetupPerformedThisRun: preflight.e2bChanged, e2bOwnershipKind: preflight.e2bOwnership.kind,
    e2bObservedUpdatedAtText: observed.updatedAtText,
    inputs: { historicalFixtureSha256: REENTRY.historicalFixtureSha256, releaseProjectionSha256: REENTRY.releaseProjectionSha256,
      preflightSha256: input.preflightSha256, creditShareSha256: input.creditShareSha256 },
    fixtureSha256: hash(fixtureBytes), creditShareStateSha256: hash(input.creditShareBytes),
    startGuardRequiredMarginMs: 100 * 60_000, composedAt: new Date(now).toISOString() }
  return { fixtureBytes, creditShareBytes: input.creditShareBytes, admission }
}

async function main(args) {
  const names = ['preflight','preflight-sha256','credit-share','credit-share-sha256','previous-fixture','release-projection','app-sha','operator-sha','marker','out-dir']
  check(args.length === names.length * 2, 'cli_arguments_invalid')
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2)
    check(args[i]?.startsWith('--') && names.includes(key) && !(key in options) && args[i + 1], 'cli_arguments_invalid')
    options[key] = args[i + 1]
  }
  const [preflightBytes, creditShareBytes, previousFixtureBytes, releaseProjectionBytes] = await Promise.all(
    ['preflight','credit-share','previous-fixture','release-projection'].map(key => readFile(options[key])))
  const result = composeReentryFixture({ preflightBytes, creditShareBytes, previousFixtureBytes, releaseProjectionBytes,
    preflightSha256: options['preflight-sha256'], creditShareSha256: options['credit-share-sha256'],
    appSha: options['app-sha'], operatorSha: options['operator-sha'], marker: options.marker })
  const dir = resolve(options['out-dir'])
  await mkdir(dir, { recursive: true })
  for (const [name, bytes] of [['fixture-state.json',result.fixtureBytes], ['credit-share-state.json',result.creditShareBytes],
    ['reentry-fixture-admission.json',Buffer.from(JSON.stringify(result.admission, null, 2) + '\n')]]) {
    await writeFile(resolve(dir, name), bytes, { flag: 'wx', mode: 0o600 })
  }
  console.log(JSON.stringify({ phase: 'reentry_fixture_composition', status: 'prepared',
    fixtureSha256: result.admission.fixtureSha256, creditShareStateSha256: result.admission.creditShareStateSha256 }))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(JSON.stringify({ phase: 'reentry_fixture_composition', status: 'failed',
      code: /^issue1503_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'issue1503_reentry_composition_failed' }))
    process.exitCode = 1
  })
}
