import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const count = z.number().int().min(0).max(512)
const yes = z.literal(true)
const optionalYes = yes.optional()
const hash = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
const fuseState = z.boolean().nullable()
const fuses = z.strictObject({
  RunAsNode: fuseState, EnableCookieEncryption: fuseState,
  EnableNodeOptionsEnvironmentVariable: fuseState, EnableNodeCliInspectArguments: fuseState,
  EnableEmbeddedAsarIntegrityValidation: fuseState, OnlyLoadAppFromAsar: fuseState,
  LoadBrowserProcessSpecificV8Snapshot: fuseState, GrantFileProtocolExtraPrivileges: fuseState,
})
const packageReport = z.strictObject({
  version: z.literal(1), variant: z.enum(['dev', 'acceptance', 'other']), passed: z.boolean(),
  signatureVerifiedStrictDeep: optionalYes,
  bundleIdentifier: z.literal('com.aspectlylabs.mikka.dev').optional(), urlScheme: z.literal('mikka-dev-auth').optional(),
  architecture: z.literal('arm64').optional(),
  identity: z.strictObject({ adHoc: yes, teamIdentifier: z.literal('none'), hardenedRuntime: yes, cdHash: hash }).optional(),
  signedBundleCount: count.optional(),
  entitlements: z.strictObject({ hardenedRuntime: yes, devOnlyLibraryValidationException: yes, unexpected: z.literal(false), executables: count, libraries: count, librariesWithoutEntitlements: count }).optional(),
  fuses: fuses.optional(),
  failure: z.enum(['MAC_PACKAGE_ARGUMENTS', 'MAC_PACKAGE_PLATFORM', 'MAC_PACKAGE_SIGNATURE', 'MAC_PACKAGE_IDENTITY',
    'MAC_PACKAGE_HARDENED_RUNTIME', 'MAC_PACKAGE_ENTITLEMENTS', 'MAC_PACKAGE_ENTITLEMENTS_FORMAT', 'MAC_PACKAGE_MACHO_TYPE',
    'MAC_PACKAGE_INFO', 'MAC_PACKAGE_URL_SCHEME', 'MAC_PACKAGE_ARCHITECTURE', 'MAC_PACKAGE_FUSES', 'MAC_PACKAGE_NESTED_SIGNATURE',
    'MAC_PACKAGE_COMMAND_FAILED', 'MAC_PACKAGE_VERIFICATION_FAILED']).optional(),
}).refine(value => value.passed
  ? value.signatureVerifiedStrictDeep && value.bundleIdentifier && value.urlScheme && value.architecture && value.identity && !value.failure
    && value.entitlements?.executables >= 1 && value.entitlements?.libraries >= 1
    && value.signedBundleCount === value.entitlements.executables + value.entitlements.libraries
    && value.entitlements.librariesWithoutEntitlements <= value.entitlements.libraries
    && value.fuses?.RunAsNode === false && value.fuses?.EnableNodeOptionsEnvironmentVariable === false
    && value.fuses?.EnableNodeCliInspectArguments === (value.variant === 'acceptance') && value.fuses?.OnlyLoadAppFromAsar === true
  : Boolean(value.failure))

const cryptoResult = z.strictObject({
  passed: z.boolean(), phase: z.enum(['create', 'continue', 'verify', 'other']),
  available: z.boolean(), verifiedCanaries: z.number().int().min(0).max(2), encrypted: z.boolean(), decrypted: z.boolean(),
  identityMatches: optionalYes,
  failure: z.strictObject({
    stage: z.enum(['identity', 'availability', 'canary-read', 'prior-decrypt', 'encrypt', 'decrypt', 'canary-write']),
    kind: z.enum(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'other']),
    code: z.enum(['EACCES', 'EPERM', 'ENOENT', 'EEXIST', 'ELOOP', 'ENOSPC', 'EIO', 'EROFS', 'NATIVE_CRYPTO_CHECK_FAILED', 'other']),
  }).optional(),
}).refine(value => value.passed ? value.identityMatches && value.available && value.encrypted && value.decrypted && !value.failure : Boolean(value.failure))
const launch = z.strictObject({
  mode: z.enum(['bundled', 'hosted']), profile: z.enum(['a', 'b']), phase: z.enum(['create', 'continue', 'verify']),
  passed: z.boolean(), crypto: cryptoResult.optional(), processExited: optionalYes,
  keychainLog: z.strictObject({
    observation: z.literal('after-launch-return'), lookupFailureCount: z.number().int().min(0).max(100),
    knownStatusCodes: z.array(z.union([-25291, -25293, -25300, -25308, -67050, -67062].map(value => z.literal(value)))).max(6),
    truncated: z.boolean(),
  }).optional(),
}).refine(value => !value.passed || (value.crypto?.passed && value.processExited && value.crypto.phase === value.phase))
const cryptoReport = z.strictObject({
  version: z.literal(1), passed: z.boolean(), platform: z.literal('darwin'), architecture: z.literal('arm64'),
  revision: z.string().regex(/^[0-9a-f]{40}$/).nullable(), launches: z.array(launch).max(3),
  package: packageReport.optional(), sameImmutablePackage: optionalYes, distinctProcesses: z.literal(3).optional(),
  failure: z.strictObject({
    stage: z.enum(['package-verification', 'launch', 'crypto', 'close', 'final-package-verification']),
    code: z.enum(['NATIVE_CRYPTO_PACKAGE_INVALID', 'NATIVE_CRYPTO_REUSED_PROCESS', 'NATIVE_CRYPTO_TIMEOUT',
      'NATIVE_CRYPTO_FAILED', 'NATIVE_CRYPTO_PRIOR_CANARY_MISSING', 'NATIVE_CRYPTO_PROCESS_EXIT_TIMEOUT',
      'NATIVE_CRYPTO_PROCESS_EXIT_FAILED', 'NATIVE_CRYPTO_CLOSE_FAILED', 'NATIVE_CRYPTO_PACKAGE_CHANGED', 'NATIVE_CRYPTO_HARNESS_FAILED']),
    closeReason: z.enum(['navigation', 'target-closed', 'installer-active', 'cancel-timeout', 'process-exit-timeout', 'process-exit-failed', 'other']).optional(),
  }).refine(value => !value.closeReason || value.stage === 'close').optional(),
  cleanup: z.enum(['passed', 'failed']),
}).refine(value => !value.passed || (value.package?.passed && value.sameImmutablePackage && value.distinctProcesses === 3
  && value.cleanup === 'passed' && !value.failure && value.launches.length === 3
  && value.launches.every((item, index) => item.passed && item.mode === ['bundled', 'hosted', 'bundled'][index]
    && item.profile === ['a', 'b', 'b'][index] && item.phase === ['create', 'continue', 'verify'][index]
    && item.crypto?.verifiedCanaries === index)))

const files = new Map([
  ['mac-acceptance-package.json', { schema: packageReport, variant: 'acceptance' }],
  ['mac-dev-package.json', { schema: packageReport, variant: 'dev' }],
  ['native-crypto.json', { schema: cryptoReport }],
])

export function validateNativeReport(value, kind) {
  const schema = kind === 'package' ? packageReport : kind === 'crypto' ? cryptoReport : undefined
  if (!schema?.safeParse(value).success) throw new Error('NATIVE_EVIDENCE_SCHEMA_INVALID')
}

/** This separate directory can contain only these closed, credential-free
 * reports. It cannot audit screenshots, account evidence, logs or arbitrary
 * JSON, and never replaces the leased-account secret scanner. */
export async function auditNativeEvidence(directory) {
  const result = { status: 'audited', files: [] }
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const policy = files.get(entry.name)
    if (!policy || !entry.isFile() || entry.isSymbolicLink()) throw new Error('NATIVE_EVIDENCE_UNEXPECTED_FILE')
    const file = await open(join(directory, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW)
    let bytes
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size > 128 * 1024) throw new Error('NATIVE_EVIDENCE_FILE_INVALID')
      bytes = await file.readFile()
    } finally { await file.close() }
    const text = bytes.toString('utf8')
    let value
    try { value = JSON.parse(text) } catch { throw new Error('NATIVE_EVIDENCE_JSON_INVALID') }
    // Reject duplicate keys, hidden bytes or alternate encodings; audit the
    // exact canonical bytes our report writer produces, not a lossy projection.
    if (`${JSON.stringify(value, null, 2)}\n` !== text || !policy.schema.safeParse(value).success || (policy.variant && value.variant !== policy.variant)) throw new Error('NATIVE_EVIDENCE_SCHEMA_INVALID')
    result.files.push({ name: entry.name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('NATIVE_EVIDENCE_ARGUMENTS')
    console.log(JSON.stringify(await auditNativeEvidence(resolve(process.argv[2]))))
  } catch {
    console.error('NATIVE_EVIDENCE_AUDIT_FAILED')
    process.exitCode = 1
  }
}
