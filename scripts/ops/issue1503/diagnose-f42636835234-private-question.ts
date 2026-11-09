import { constants, createCipheriv, createHash, createPublicKey, publicEncrypt, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { smokeSession, SMOKE_ID } from './http.ts'

const APP = '8db16095f46be955df22f42914e0f89b6e5f3d11'
const BASE = '4084bdf195f6baae3e9b378ac17a528a5404474d'
const FAILED_SOURCE = '7017d5f14871cbf1aeea771824d72e1d2bd90255'
const FIXTURE_SHA = '9e0836aa5e5d290dac5c282e82f56907b99207820ded44396159b935c53f9de7'
const HTTP_HELPER_SHA = 'fe96ea60b8924a8070c0ab6dfe15ef08838856780798a574cb88d69b62b91dec'
const PUBLIC_KEY_SHA = '2a3f2d8917ad66d0e8067196c68e55afd086dc864e40d5cf2d817e32d7289349'
const QUESTION_TEXT_SHA = '46b3b983bb841f5bfe463fea548177409d8cca10dbaea886a9ab34b5acf0899b'
const WORKSPACE = '93f38d33-9447-4eaf-8a46-0d8889165bcd'
const TARGET = {
  questionId: '6e8e0149-f41d-4f5e-b7de-84f31fe3abe1',
  taskId: '4ad3fce3-a6e8-40b3-9248-df1ea6bc9faf',
  issueId: 'c38abb4c-2f8a-48ea-b70b-9f2badda85ee',
  attemptId: '6c188012-f9e6-4c22-92ed-0e6a70233eca',
  originRunId: '0450e5aa-7891-47b9-90db-3a1f6b4b9ca3',
} as const
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const textHash = (value: unknown) => typeof value === 'string' ? hash(value) : null
const integer = (value: unknown) => Number.isSafeInteger(value) ? value : null
const words = (value: unknown, choices: readonly string[]) => typeof value === 'string' && choices.includes(value) ? value : null
const STATES = ['open', 'waiting_user', 'answered', 'resuming', 'resolved', 'blocked', 'cancelled', 'expired', 'superseded']
const ERROR_CODES = ['authRequired', 'factoryNotFound', 'factoryHumanRequired', 'factoryInvalid',
  'factoryLifecycleUnavailable', 'workspaceAccessDenied', 'botNotFound', 'validationGeneric',
  'originRejected', 'methodNotAllowed', 'factoryConflict', 'factoryStale']
class DiagnosticFailure extends Error {
  constructor(readonly code: string) { super(code); this.name = 'DiagnosticFailure' }
}
const requireThat = (value: unknown, code: string) => { if (!value) throw new DiagnosticFailure(code) }
const safeFailure = (error: unknown) => error instanceof DiagnosticFailure ? error.code
  : error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name) ? 'request_timeout' : 'operation_failed'
type ReadKey = 'version_before' | 'question' | 'version_after'
const report: any = {
  issue: 1503, phase: 'private_external_question_diagnosis_42636835234', acceptancePassed: false,
  expectedAppSha: APP, preparationBase: BASE, failedFSource: FAILED_SOURCE, failedFRunId: 42636835234, failedFAttempt: 1,
  historicalFixtureSha256: FIXTURE_SHA, historicalFixtureIdentityOnly: true, credentialsNotReused: true,
  credentialReuseScope: 'historical_fixture_and_github_child', normalSmokeLogin: true,
  workspaceId: WORKSPACE, target: TARGET, expectedQuestionType: 'external', expectedQuestionTextSha256: QUESTION_TEXT_SHA,
  recipientPublicKeySha256: PUBLIC_KEY_SHA,
  operatorSha: process.env.GITHUB_SHA ?? null, workflowRunId: process.env.GITHUB_RUN_ID ?? null,
  workflowAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  snapshotTiming: 'one_fixed_existing_question_after_failed_window_cleanup',
  startedAt: new Date().toISOString(), stage: 'configuration', status: 'started',
  counts: { version_before: 0, question: 0, version_after: 0 },
  requests: {}, failures: [],
}
let session: Awaited<ReturnType<typeof smokeSession>> | null = null
let recipient: ReturnType<typeof createPublicKey> | null = null
const save = async () => {
  await mkdir('issue1503-report', { recursive: true, mode: 0o700 })
  await writeFile('issue1503-report/private-question-6e8e0149.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
}
async function once(name: ReadKey, path: string) {
  const expectedPath = name === 'question' ? '/api/factory/questions/' + TARGET.questionId : '/api/version'
  requireThat(session && report.counts[name] === 0 && path === expectedPath, 'request_binding_invalid')
  report.counts[name]++
  const receipt: any = report.requests[name] = { method: 'GET', path, startedAt: new Date().toISOString() }
  try {
    const response = await session!.request(path, { method: 'GET',
      headers: { cookie: 'mikka-workspace=' + WORKSPACE, 'x-mikka-locale': 'en' } })
    const bytes = Buffer.from(await response.arrayBuffer())
    receipt.completedAt = new Date().toISOString()
    receipt.httpStatus = response.status; receipt.httpOk = response.ok
    receipt.responseBytes = bytes.length; receipt.responseSha256 = hash(bytes)
    let value: any
    try { value = JSON.parse(bytes.toString('utf8')) }
    catch { throw new DiagnosticFailure('response_json_invalid') }
    finally { bytes.fill(0) }
    receipt.errorCode = words(value?.error, ERROR_CODES); receipt.errorCodeSha256 = textHash(value?.error)
    requireThat(response.ok, 'http_failed')
    return value
  } catch (error) {
    receipt.completedAt ??= new Date().toISOString(); receipt.failureCode = safeFailure(error)
    throw error
  }
}
function sealQuestion(questionText: string) {
  requireThat(recipient && hash(questionText) === QUESTION_TEXT_SHA, 'question_text_or_recipient_mismatch')
  const scope = {
    format: 'mikka.issue1503.private-question.v1',
    ...TARGET, workspaceId: WORKSPACE, ownerId: SMOKE_ID, questionType: 'external',
    questionTextSha256: QUESTION_TEXT_SHA, expectedAppSha: APP,
    operatorSha: report.operatorSha, workflowRunId: report.workflowRunId, workflowAttempt: report.workflowAttempt,
    recipientPublicKeySha256: PUBLIC_KEY_SHA,
  }
  const aad = Buffer.from(JSON.stringify(scope), 'utf8')
  const plaintext = Buffer.from(JSON.stringify({ question: questionText }), 'utf8')
  const key = randomBytes(32)
  const nonce = randomBytes(12)
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
    cipher.setAAD(aad)
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const tag = cipher.getAuthTag()
    const wrappedKey = publicEncrypt({
      key: recipient!, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256',
    }, key)
    requireThat(tag.length === 16 && wrappedKey.length === 384, 'envelope_length_invalid')
    return {
      format: scope.format, scope,
      keyWrapAlgorithm: 'RSA-OAEP-SHA256', contentAlgorithm: 'AES-256-GCM',
      recipientPublicKeySha256: PUBLIC_KEY_SHA,
      plaintextBytes: plaintext.length, plaintextSha256: hash(plaintext),
      ciphertextBytes: ciphertext.length, ciphertextSha256: hash(ciphertext),
      ciphertextBase64: ciphertext.toString('base64'),
      nonceBase64: nonce.toString('base64'), tagBase64: tag.toString('base64'),
      wrappedKeyBase64: wrappedKey.toString('base64'),
      aadBase64: aad.toString('base64'), aadSha256: hash(aad),
    }
  } finally {
    key.fill(0)
    plaintext.fill(0)
  }
}
function readAllowedQuestion(value: any) {
  requireThat(value?.id === TARGET.questionId && value.userId === SMOKE_ID
    && value.taskId === TARGET.taskId && value.issueId === TARGET.issueId
    && value.attemptId === TARGET.attemptId && value.originRunId === TARGET.originRunId
    && value.stage === 'execute' && value.kind === 'external', 'question_scope_mismatch')
  requireThat(typeof value.question === 'string' && hash(value.question) === QUESTION_TEXT_SHA, 'question_text_changed')
  // Never serialize the API object: its other fields can contain private native metadata.
  report.question = { ...TARGET, type: 'external', status: words(value.status, STATES),
    revision: integer(value.revision), textSha256: QUESTION_TEXT_SHA }
  try {
    report.sealedQuestion = sealQuestion(value.question)
  } finally {
    delete value.question
  }
}
try {
  requireThat(process.env.MIKKA_1503_PRIVATE_QUESTION_DIAGNOSTIC_GO === 'read_and_seal_fixed_question_once', 'diagnostic_not_enabled')
  requireThat(process.env.GITHUB_REF === 'refs/heads/ops/issue-1503-production-smoke'
    && process.env.GITHUB_EVENT_NAME === 'push' && /^[a-f0-9]{40}$/.test(report.operatorSha ?? '')
    && /^[1-9][0-9]*$/.test(report.workflowRunId ?? '') && report.workflowAttempt === '1', 'operator_binding_invalid')
  requireThat(/^[a-f0-9]{40}$/.test(APP) && process.env.MIKKA_EXPECTED_DEPLOYMENT_SHA === APP
    && process.env.MIKKA_1503_START_FIXTURE_SHA256 === FIXTURE_SHA, 'configuration_mismatch')
  report.scriptSha256 = hash(await readFile(new URL(import.meta.url)))
  report.httpHelperSha256 = hash(await readFile(new URL('./http.ts', import.meta.url)))
  requireThat(report.httpHelperSha256 === HTTP_HELPER_SHA, 'http_helper_source_changed')
  const fixtureBytes = await readFile('scripts/ops/issue1503/fixture-state.json')
  requireThat(hash(fixtureBytes) === FIXTURE_SHA, 'historical_fixture_sha_mismatch')
  report.historicalFixtureVerified = true
  const publicPem = await readFile(new URL('./recipient-question-6e8e0149-public.pem', import.meta.url))
  requireThat(hash(publicPem) === PUBLIC_KEY_SHA, 'recipient_public_key_changed')
  recipient = createPublicKey(publicPem)
  requireThat(recipient.asymmetricKeyType === 'rsa'
    && recipient.asymmetricKeyDetails?.modulusLength === 3072, 'recipient_key_invalid')
  report.recipientPublicKeyVerified = true
  await save()
  report.stage = 'normal_login'
  session = await smokeSession()
  requireThat(session.user.id === SMOKE_ID, 'identity_mismatch')
  report.sessionOpened = true
  report.stage = 'production_before'
  const before = await once('version_before', '/api/version')
  report.productionBefore = typeof before?.build === 'string' && /^[a-f0-9]{40}$/.test(before.build) ? before.build : null
  requireThat(report.productionBefore === APP, 'production_source_changed')
  report.stage = 'read_and_seal_fixed_question_once'
  readAllowedQuestion(await once('question', '/api/factory/questions/' + TARGET.questionId))
  await save()
} catch (error) {
  report.failures.push({ operation: report.stage, code: safeFailure(error) })
} finally {
  if (session) {
    try {
      const after = await once('version_after', '/api/version')
      report.productionAfter = typeof after?.build === 'string' && /^[a-f0-9]{40}$/.test(after.build) ? after.build : null
      requireThat(report.productionAfter === APP && report.productionBefore === APP, 'production_source_changed')
    } catch (error) { report.failures.push({ operation: 'production_after', code: safeFailure(error) }) }
    report.logout = { attempted: true, transportResolved: false, responseStatusAvailable: false }
    try { await session.close(); report.logout.transportResolved = true }
    catch (error) { report.failures.push({ operation: 'normal_logout', code: safeFailure(error) }) }
  }
  report.businessReadsAttempted = report.counts.question
  report.status = report.failures.length === 0 && report.counts.question === 1 && report.sealedQuestion
    && report.counts.version_before === 1 && report.counts.version_after === 1 ? 'completed' : 'failed'
  report.stage = 'finished'; report.completedAt = new Date().toISOString()
  await save()
  console.log(JSON.stringify({ phase: report.phase, status: report.status, counts: report.counts,
    sealedQuestionPresent: Boolean(report.sealedQuestion), failureCount: report.failures.length }))
  if (report.status !== 'completed') process.exitCode = 1
}
