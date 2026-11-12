import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const script = resolve('scripts/release/self-hosted-stable.sh')
const policy = resolve('scripts/self-hosted-update-policy.mjs')
const digest = 'sha256:' + 'a'.repeat(64)
// Exercise the actual shell entry point with isolated Git refs, local registry
// and Actions command fixtures. No production credentials or outbound calls.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'self-hosted-promote-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid')
  git('init', '--bare', 'upstream.git')
  git('remote', 'add', 'origin', join(dir, 'upstream.git'))
  git('commit', '--allow-empty', '-m', 'initial')
  for (const directory of ['bin', 'config', 'scripts', 'drizzle']) mkdirSync(join(dir, directory))
  cpSync(policy, join(dir, 'scripts/self-hosted-update-policy.mjs'))
  writeFileSync(join(dir, 'config/self-hosted-stable-version'), 'v1.0.0\n')
  git('add', 'config'); git('commit', '-m', 'release')
  const sha = git('rev-parse', 'HEAD')
  writeFileSync(join(dir, 'bin/gh'), `#!/usr/bin/env bash
set -eu
case "$*" in
  *'/workflows/'*'/runs'*)
    state=completed; conclusion=success
    if [[ "$*" == *ui-policy.yml* ]]; then state=$SOURCE_STATE; conclusion=$SOURCE_RESULT; fi
    jq -n --arg sha "$SOURCE_SHA" --arg state "$state" --arg conclusion "$conclusion" '{workflow_runs:[{id:77,run_attempt:2,head_sha:$sha,head_branch:"main",event:"push",status:$state,conclusion:$conclusion}]}';;
  *'/attempts/2/jobs?'*) jq -n --arg sha "$SOURCE_SHA" --arg result "$IMAGE_RESULT" '{jobs:[{name:"image",head_sha:$sha,conclusion:$result}]}';;
  *'/releases/tags/'*) echo 'gh: Not Found (HTTP 404)' >&2; exit 1;;
  'release create '*) cp "$RUNNER_TEMP/self-hosted-release-notes.md" "$RUNNER_TEMP/published.md";;
  *) echo "Unexpected gh operation" >&2; exit 2;;
esac
`, { mode: 0o700 })
  writeFileSync(join(dir, 'bin/skopeo'), `#!/usr/bin/env bash
set -eu
case "$*" in
  'login '*) cat >/dev/null;;
  'list-tags '*) echo '{"Tags":[]}';;
  'copy '*) :;;
  'inspect --config '*) jq -n --arg sha "$LABEL_SHA" '{config:{Labels:{"org.opencontainers.image.revision":$sha}}}';;
  'inspect --format '*)
    if [[ "$*" == *":ci-77-2" ]]; then echo "$RECEIPT_DIGEST"; else echo "$TAG_DIGEST"; fi;;
  *) echo 'Unexpected registry operation' >&2; exit 2;;
esac
`, { mode: 0o700 })
  const env = { ...process.env, PATH: join(dir, 'bin') + ':' + process.env.PATH, SOURCE_SHA: sha, TRIGGER_BRANCH: 'main',
    SOURCE_STATE: 'completed', SOURCE_RESULT: 'success', IMAGE_RESULT: 'success', LABEL_SHA: sha, GH_TOKEN: 'test',
    GITHUB_ACTOR: 'test', TAG_DIGEST: digest, RECEIPT_DIGEST: digest, RUNNER_TEMP: dir,
    GITHUB_STEP_SUMMARY: join(dir, 'summary'), GITHUB_OUTPUT: join(dir, 'output') }
  return { dir, sha, git, run: extra => spawnSync('bash', [script], { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8' }) }
}

test('stable publication binds source, migration fingerprint and tested image digest', t => {
  const f = fixture(t)
  const r = f.run({})
  assert.equal(r.status, 0, r.stderr)
  assert.equal(f.git('rev-parse', 'refs/tags/v1.0.0'), f.sha)
  const release = readFileSync(join(f.dir, 'published.md'), 'utf8')
  assert.ok(release.includes('sha=' + f.sha + ' digest=' + digest))
  assert.ok(release.includes('https://github.com/alexj11324/Mikka/releases/tag/v1.0.0'))
  assert.ok(readFileSync(join(f.dir, 'output'), 'utf8').includes('digest=' + digest))
})

test('failed or incomplete checks, a retagged SHA or a wrong revision cannot publish', t => {
  const f = fixture(t)
  for (const [extra, status, code] of [
    [{ SOURCE_STATE: 'in_progress' }, 0, 'Waiting for the other workflow'],
    [{ SOURCE_RESULT: 'failure' }, 1, 'RELEASE_CHECK_FAILED'],
    [{ IMAGE_RESULT: 'skipped' }, 1, 'IMAGE_ACCEPTANCE_REQUIRED'],
    [{ TAG_DIGEST: 'sha256:' + 'b'.repeat(64) }, 1, 'RELEASE_DIGEST_MISMATCH'],
    [{ LABEL_SHA: 'c'.repeat(40) }, 1, 'RELEASE_IMAGE_MISMATCH'],
  ]) {
    const r = f.run(extra)
    assert.equal(r.status, status, r.stderr)
    assert.ok((r.stdout + r.stderr).includes(code), r.stderr)
    assert.equal(f.git('tag', '--list'), '')
  }
})
