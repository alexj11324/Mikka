import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const bin = process.env.PG_BINDIR || '/usr/lib/postgresql/17/bin'
const target = 'drizzle/20261029011701_cli_run_policy.sql'

test('Node, pnpm and real PostgreSQL run the Mikka CLI policy migration in a private cluster', () => {
  assert.equal(process.versions.node.split('.')[0], '24')
  assert.equal(execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim(), '10.34.3')
  assert.notEqual(process.getuid(), 0, 'the engineering database must run unprivileged')
  const root = mkdtempSync(join(tmpdir(), 'mikka-pg17-'))
  const data = join(root, 'data')
  const socket = join(root, 'socket')
  mkdirSync(socket, { mode: 0o700 })
  const sql = (...args) => execFileSync(join(bin, 'psql'), [
    '-X', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-d', 'postgres', '-U', 'engineering', '-At', ...args,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 })
  let started = false
  try {
    execFileSync(join(bin, 'initdb'), ['--no-locale', '--encoding=UTF8', '-A', 'trust', '-U', 'engineering', '-D', data])
    execFileSync(join(bin, 'pg_ctl'), ['-D', data, '-l', join(root, 'postgres.log'), '-w', '-t', '20',
      '-o', "-h '' -k " + socket, 'start'])
    started = true
    const version = Number(sql('-c', 'show server_version_num').trim())
    assert.ok(version >= 170000 && version < 180000, 'PostgreSQL 17 required')
    assert.equal(sql('-c', 'show listen_addresses').trim(), '')
    sql('-c', 'CREATE TABLE agents(id int primary key); CREATE TABLE agent_kit_heads(id int primary key); CREATE TABLE workspace_computer_policies(id int primary key); CREATE TABLE agent_tool_approvals(id int primary key)')
    sql('-f', target)
    assert.equal(sql('-c', "INSERT INTO agents(id) VALUES (1) RETURNING cli_run_policy_version").split('\n')[0], '0')
    assert.equal(sql('-c', `UPDATE agents SET cli_run_policy='{"permissions":{"network":"deny"}}' WHERE id=1 RETURNING cli_run_policy_version`).split('\n')[0], '1')
    assert.throws(() => sql('-c', 'UPDATE agents SET cli_run_policy_version=77 WHERE id=1'), /CLI policy version is automatic/)
    sql('-c', `BEGIN; UPDATE agents SET cli_run_policy='{}' WHERE id=1; ROLLBACK;`)
    assert.equal(sql('-c', 'SELECT cli_run_policy_version FROM agents WHERE id=1').trim(), '1')
    console.log('runtime ' + JSON.stringify({ node: process.version, pnpm: '10.34.3', postgresVersionNumber: version, listen: 'unix socket' }))
  } finally {
    try {
      if (started) execFileSync(join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', '-t', '20', 'stop'])
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  }
})
