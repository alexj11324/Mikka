import { pathToFileURL } from 'node:url'
import { verifiedRuntimeEnvironment } from './publish-template-env.mjs'
import { readRuntimeReport, TEMPLATE_KINDS, templateModels } from './runtime-report.mjs'

/** The private publisher authenticates the GitHub artifact before passing its release.json here. */
export function cloudflareRuntimeConfiguration(file, expected) {
  const releaseEvidence = readRuntimeReport(file, expected)
  const templates = Object.fromEntries(TEMPLATE_KINDS.map(kind => [kind, releaseEvidence.templates[kind].templateId]))
  const environment = verifiedRuntimeEnvironment({
    releaseEvidence, templates, sourceSha: expected.workerSha, sourceCommit: expected.sourceCommit,
    models: templateModels(releaseEvidence),
  })
  return Object.fromEntries(environment.map(({ key, value }) => [key, value]))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, sourceCommit, workerSha, runId, runAttempt, sha256] = process.argv.slice(2)
  try {
    const configuration = cloudflareRuntimeConfiguration(file, { sourceCommit, workerSha, runId, runAttempt, sha256 })
    process.stdout.write(JSON.stringify(configuration) + '\n')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
