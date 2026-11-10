import { join } from 'node:path'

export function plan(repo, harness, output, sha = '<FIXED_CODE_SHA>') {
  const node = process.execPath
  const db = ['--test-force-exit', '--experimental-test-module-mocks', '--import', './tests/support/server-only.mjs', '--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=spec']
  return [
    { id: '01-postgresql-gates', title: 'PostgreSQL: evidence gates and completion ordering', commands: [
      { cwd: repo, bin: node, args: [...db, 'lib/captures/video-evidence.db.test.ts', 'lib/captures/publication.db.test.ts',
        'lib/factory/checks.db.test.ts', 'lib/factory/approval.db.test.ts', 'lib/factory/merge.db.test.ts',
        'tests/run-publications.db.test.ts', 'lib/factory/activity-artifacts.db.test.ts', 'lib/factory/task-media.db.test.ts'], tests: 'node' },
    ] },
    { id: '02-real-http', title: 'Real Vite/Nitro HTTP: activity, media, report and scope', commands: [
      { cwd: repo, bin: node, args: ['--import', './scripts/server-test.mjs', '--import', 'tsx', '--test', '--test-reporter=spec', 'tests/factory-activity-http.db.test.ts'], tests: 'node' },
    ] },
    { id: '03-cli-daemon-ffmpeg', title: 'Real MCP CLI, daemon finalization and FFmpeg readback', commands: [
      { cwd: join(repo, 'packages/daemon'), bin: node, args: ['node_modules/vitest/vitest.mjs', 'run', 'test/captures.test.ts', 'test/terminal-checkpoint.test.ts', 'test/publication-cancel.test.ts', 'test/server-link-http.test.ts', '--reporter=verbose'], tests: 'vitest' },
      { cwd: repo, bin: node, args: ['--test', '--test-reporter=spec', 'packages/daemon/test/capture-video.node-test.mjs'], tests: 'node' },
      { cwd: repo, bin: node, args: [join(harness, 'oversize-readback.mjs'), repo, join(output, 'ffmpeg-readback')], tests: null },
    ] },
    { id: '04-activity-registration', title: 'Real capture upload, versioned reports and activity GET readback', commands: [
      { cwd: repo, bin: node, args: ['--import', './scripts/server-test.mjs', '--import', 'tsx', join(harness, 'register-readback.mjs'), repo, output, sha], tests: null },
    ] },
  ]
}
