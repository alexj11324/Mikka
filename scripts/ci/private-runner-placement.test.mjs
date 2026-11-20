import assert from 'node:assert/strict'
import test from 'node:test'
import { assertApprovedWorkflowBytes, assertPrivateRunnerPlacement } from './private-runner-placement.mjs'

const legacy = 'on: workflow_dispatch\njobs:\n  legacy:\n    runs-on: ubuntu-latest\n    steps: []\n'
const cloudflare = 'on: workflow_dispatch\njobs:\n  canary:\n    runs-on: [self-hosted, linux, x64, mikka-runtime-observer]\n    steps: []\n'
const legacyPath = '.github/workflows/legacy.yml'
const cloudflarePath = '.github/workflows/canary.yml'
const approved = {
  [legacyPath]: '4aa4aba7d186f1e621c87b7969a5801a9921aa3aff8388912ba184a9059e3b9d',
  [cloudflarePath]: 'bac81944c034508665eeef47e96f3ccec68782b84fe8119bd09ca5995e4d2da7',
}
const file = (path, bytes, mode = '100644') => ({ path, bytes, mode })
const refused = files => assert.throws(() => assertApprovedWorkflowBytes(files, approved), /CLOUD_PUBLIC_CI_PRIVATE_RUNNER_PLACEMENT/)

test('only the reviewed legacy and Cloudflare workflow bytes are admitted; removals remain possible', () => {
  assertApprovedWorkflowBytes([file(legacyPath, legacy), file(cloudflarePath, cloudflare)], approved)
  assertApprovedWorkflowBytes([file(cloudflarePath, cloudflare)], approved)
  assertApprovedWorkflowBytes([], approved)
})

test('new jobs, hosted fallbacks, YAML aliases, reusable jobs and even harmless edits require public policy review', () => {
  for (const bytes of [
    legacy.replace('ubuntu-latest', 'macos-26'),
    legacy.replace('ubuntu-latest', '${{ inputs.runner || \'ubuntu-latest\' }}'),
    legacy.replace('ubuntu-latest', '*unreviewed_runner'),
    legacy + '  another:\n    runs-on: ubuntu-latest\n    steps: []\n',
    legacy + '  reused:\n    uses: owner/repository/.github/workflows/private.yml@main\n',
    legacy + 'jobs:\n  replacement:\n    runs-on: ubuntu-latest\n',
    legacy + '# Edited workflow\n',
  ]) refused([file(legacyPath, bytes)])
  refused([file(cloudflarePath, cloudflare.replace('[self-hosted, linux, x64, mikka-runtime-observer]', 'ubuntu-latest'))])
})

test('unreviewed names, reinstated funded acceptance, symlinks and duplicate workflow records fail closed', () => {
  for (const path of ['.github/workflows/new.yml', '.github/workflows/renamed.yml', '.github/workflows/funded-model-acceptance.yml'])
    refused([file(path, legacy)])
  refused([file(legacyPath, legacy, '120000')])
  refused([file(legacyPath, legacy), file(legacyPath, legacy)])
  const inherited = Object.create(approved)
  assert.throws(() => assertApprovedWorkflowBytes([file(legacyPath, legacy)], inherited), /PRIVATE_RUNNER_PLACEMENT/)
})

test('checkout admission requires an immutable commit identifier', () => {
  for (const source of ['main', '', undefined, 'a'.repeat(39), 'a'.repeat(41)])
    assert.throws(() => assertPrivateRunnerPlacement('/not-a-checkout', source), /PRIVATE_RUNNER_PLACEMENT/)
})
