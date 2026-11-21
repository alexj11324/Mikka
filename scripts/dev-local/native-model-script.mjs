// The native CLI still owns filesystem, Git and MCP execution. This script only
// chooses the next model tool call and quotes observations already returned.
import { reply, scriptContext } from './model-scripts.mjs'

export function nativeLocalModelAnswer(request) {
  const c = scriptContext(request)
  if (!c.has('submit')) return null
  const marker = /local acceptance ([a-f0-9-]{36})/.exec(c.all)?.[1]
  const readOnly = /验收标记：[a-f0-9-]{36}-item[23]/.test(c.all)
  const worker = /Personal mailbox notification acceptance (worker-mailbox-[a-f0-9-]{36})/.exec(c.all)?.[1]
  if (!marker && !readOnly && !worker) return null
  const inspect = c.results('inspect_artifact', true)
  const shell = c.results('Bash', true).map(value => typeof value === 'string' ? value : JSON.stringify(value))
  if (c.results('submit', true).length) return reply('The real submit tool recorded the hand-in.')
  const factory = /Factory stage: (review|verify)\./.exec(c.all)?.[1]
  if (worker && !factory) {
    if (!c.results('mailbox_recipients', true).length) return c.call('mailbox_recipients', {})
    if (c.has('inspect_artifact') && inspect.length < 8) return c.call('inspect_artifact', { path: 'README.md' })
    // The notification handler in model-scripts.mjs consumes actual inbox,
    // sender and ACK receipts. A finished finite workload alone is not a pass.
    if (!c.results('mailbox_ack', true).length) return { status: 422, code: 'fixture_worker_notification_not_observed' }
    return c.call('submit', { summary: `Read README.md and handled ${worker} through actual mailbox tools.`, criteria: [{ text: 'Read-only mailbox exchange', passed: true, evidence: JSON.stringify({ inspections: inspect, acknowledgements: c.results('mailbox_ack', true) }) }] })
  }
  if (factory || readOnly) {
    if (!inspect.length) return c.call('inspect_artifact', { path: 'README.md' })
    const contents = inspect[0]?.contentUtf8
    if (typeof contents !== 'string') return { status: 422, code: 'fixture_artifact_content_missing' }
    if (marker && !contents.includes(`local acceptance ${marker}`)) return { status: 422, code: 'fixture_candidate_marker_missing' }
    if (factory === 'verify' && c.has('verify_command')) {
      if (inspect.length < 2) return c.call('inspect_artifact', { path: 'package.json' })
      const packageText = inspect[1]?.contentUtf8
      if (!packageText || JSON.parse(packageText)?.scripts?.test !== 'git diff --check origin/trunk HEAD') return { status: 422, code: 'fixture_verification_script_missing' }
      if (!c.results('verify_command', true).length) return c.call('verify_command', { command: 'npm test', basis: 'package.json scripts.test' })
      const observed = c.results('verify_command', true).at(-1)
      if (observed?.exitCode !== 0) return { status: 422, code: 'fixture_verification_failed' }
    }
    return c.call('submit', {
      summary: `Inspected actual README.md bytes${factory ? ` during independent ${factory}` : ''}.`,
      ...(factory === 'review' ? { reviewVerdict: 'passed' } : {}),
      ...(factory === 'verify' && c.has('verify_command') ? { verificationCommand: { command: 'npm test', basis: 'package.json scripts.test' } } : {}),
      criteria: [{ text: marker ? `README.md contains local acceptance ${marker}` : 'Read README.md without changing the repository', passed: true, evidence: JSON.stringify({ artifact: inspect[0], command: c.results('verify_command', true).at(-1) }) }],
    })
  }
  if (!c.has('Bash')) return { status: 422, code: 'fixture_native_shell_missing' }
  if (!shell.length) return c.call('Bash', { command: 'cat README.md && cat package.json', description: 'Read the local fixture task and verification command' })
  if (!shell.some(value => value.includes('FIXTURE_COMMIT_PUSHED'))) {
    const issue = /<!-- mikka-issue:([a-f0-9-]{36}) -->/.exec(c.all)?.[1]
    const branch = /using head ([A-Za-z0-9._/-]+)\./.exec(c.all)?.[1]
    if (!issue || !branch || !shell[0].includes('git diff --check origin/trunk HEAD')) return { status: 422, code: 'fixture_native_delivery_contract_missing' }
    return c.call('Bash', {
      command: `printf '\\nlocal acceptance ${marker}\\n' >> README.md\ngit diff --check && npm test && git add README.md && git -c user.name='Mikka Fixture' -c user.email='fixture@example.test' commit -m 'test: local acceptance ${marker}' && git push https://github.com/mikka-e2e/core-loop.git HEAD:${branch} && gh pr create --head ${branch} --base trunk --title 'Local acceptance ${marker}' --body 'Scripted model; real local Git and HTTP publication.\n<!-- mikka-issue:${issue} -->' && printf '\\nFIXTURE_COMMIT_PUSHED\\n'`,
      description: 'Test, commit and publish the exact local fixture change',
    })
  }
  const published = shell.find(value => value.includes('FIXTURE_COMMIT_PUSHED'))
  const url = published.match(/https:\/\/github\.com\/mikka-e2e\/core-loop\/pull\/\d+/)?.[0]
  if (!url) return { status: 422, code: 'fixture_publication_receipt_missing' }
  if (!shell.some(value => value.includes('FIXTURE_CHECKS_PASSED'))) return c.call('Bash', { command: `gh pr checks ${url} --watch && printf '\\nFIXTURE_CHECKS_PASSED\\n'`, description: 'Read local fixture CI for the actual published head' })
  return c.call('submit', { summary: `Appended the requested README marker and published ${url}. Local fixture checks passed.`, criteria: [{ text: `README.md contains local acceptance ${marker}`, passed: true, command: 'npm test', exitCode: 0, evidence: published }] })
}
