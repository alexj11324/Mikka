import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { HOSTED_CLI_MANIFEST, LEGACY_HOSTED_CLI_MANIFEST, hostedBinaries, readHostedCliManifest, type HostedCliManifest } from './hosted-binaries'
import { cleanupTempDirs, tempDir } from '../test/helpers'

afterEach(cleanupTempDirs)
function fixture() {
  const root = tempDir(), official = join(root, 'official'), additions = join(root, 'private-bin')
  mkdirSync(official); mkdirSync(additions)
  for (const directory of [official, additions]) for (const name of ['claude', 'codex'])
    writeFileSync(join(directory, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const manifestPath = join(root, 'original-cli.json')
  const manifest: HostedCliManifest = { version: 1, kind: 'claude', original: {
    claude_code: { path: join(official, 'claude'), sha256: 'a'.repeat(64) },
    codex: { path: join(official, 'codex'), sha256: 'b'.repeat(64) },
  }, added: {} }
  const save = () => writeFileSync(manifestPath, JSON.stringify(manifest))
  save()
  return { root, official, additions, manifest, manifestPath, save }
}

it('uses exactly the recorded original CLIs even if another binary is earlier on PATH', () => {
  const f = fixture(), path = `${f.additions}:${f.official}`
  expect(hostedBinaries(undefined, { path, manifestPath: f.manifestPath }))
    .toEqual({ claude_code: join(f.official, 'claude'), codex: join(f.official, 'codex') })
  expect(() => hostedBinaries({ claude_code: join(f.additions, 'claude') }, { path, manifestPath: f.manifestPath }))
    .toThrow('recorded_cli_unavailable')
})

it('does not substitute a bundled/private binary when the recorded official CLI is missing or non-executable', () => {
  const f = fixture()
  rmSync(join(f.official, 'claude'))
  expect(() => hostedBinaries(undefined, { path: f.additions, manifestPath: f.manifestPath })).toThrow('recorded_cli_unavailable')
  writeFileSync(join(f.official, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o600 })
  expect(() => hostedBinaries(undefined, { path: f.additions, manifestPath: f.manifestPath })).toThrow('recorded_cli_unavailable')
})

it('refuses changed symlink destinations and a missing original on its own official template', () => {
  const f = fixture()
  rmSync(join(f.official, 'claude')); symlinkSync(join(f.additions, 'claude'), join(f.official, 'claude'))
  expect(() => hostedBinaries(undefined, { manifestPath: f.manifestPath })).toThrow('recorded_cli_unavailable')
  f.manifest.original.claude_code = null; f.save()
  expect(() => readHostedCliManifest(f.manifestPath)).toThrow('official_cli_missing')
})

it('permits an explicitly declared private addition only when the original template had no such CLI', () => {
  const f = fixture(); f.manifest.kind = 'desktop'; f.manifest.original.claude_code = null
  f.manifest.added.claude_code = { path: '/opt/mikka/runtime/claude', sha256: 'c'.repeat(64) }; f.save()
  expect(readHostedCliManifest(f.manifestPath)?.added.claude_code?.path).toBe('/opt/mikka/runtime/claude')
  f.manifest.added.claude_code.path = join(f.additions, 'claude'); f.save()
  expect(() => readHostedCliManifest(f.manifestPath)).toThrow('manifest_invalid')
  f.manifest.added.codex = { path: '/opt/mikka/runtime/codex', sha256: 'c'.repeat(64) }; f.save()
  expect(() => readHostedCliManifest(f.manifestPath)).toThrow('manifest_invalid')
})

it('uses a legacy image original PATH without implicitly finding the SDK bundled Claude', () => {
  const f = fixture(), missingManifest = join(f.root, 'absent.json')
  expect(hostedBinaries(undefined, { path: f.official, manifestPath: missingManifest }))
    .toEqual({ claude_code: join(f.official, 'claude'), codex: join(f.official, 'codex') })
  rmSync(join(f.official, 'claude')); chmodSync(join(f.official, 'codex'), 0o600)
  expect(hostedBinaries(undefined, { path: f.official, manifestPath: missingManifest })).toEqual({})
})

it('follows the worker release symlink on activation and rollback before the legacy inventory', () => {
  const f = fixture(), worker = join(f.root, 'worker')
  const paths = [join(worker, '.mikka-original-cli.json'), f.manifestPath]
  for (const version of ['old', 'new']) {
    const release = join(f.root, version)
    mkdirSync(release)
    writeFileSync(join(release, '.mikka-original-cli.json'), JSON.stringify({ ...f.manifest,
      original: { ...f.manifest.original, codex: null },
      added: { codex: { path: `/opt/mikka/releases/${version}/bin/codex`, sha256: 'c'.repeat(64) } },
    }))
  }
  const switchTo = (version: string) => {
    rmSync(worker, { force: true }); symlinkSync(join(f.root, version), worker)
  }
  switchTo('old')
  expect(readHostedCliManifest(paths)?.added.codex?.path).toBe('/opt/mikka/releases/old/bin/codex')
  switchTo('new')
  expect(readHostedCliManifest(paths)?.added.codex?.path).toBe('/opt/mikka/releases/new/bin/codex')
  switchTo('old')
  expect(readHostedCliManifest(paths)?.added.codex?.path).toBe('/opt/mikka/releases/old/bin/codex')
  expect(HOSTED_CLI_MANIFEST).toBe('/opt/mikka/worker/.mikka-original-cli.json')
  expect(LEGACY_HOSTED_CLI_MANIFEST).toBe('/opt/mikka/original-cli.json')
})

it('uses the legacy inventory only when the release has none, then the original PATH when both are absent', () => {
  const f = fixture(), paths = [join(f.root, 'missing-release-manifest.json'), f.manifestPath]
  expect(hostedBinaries(undefined, { manifestPath: paths, path: f.additions }))
    .toEqual({ claude_code: join(f.official, 'claude'), codex: join(f.official, 'codex') })
  rmSync(f.manifestPath)
  expect(hostedBinaries(undefined, { manifestPath: paths, path: f.official }))
    .toEqual({ claude_code: join(f.official, 'claude'), codex: join(f.official, 'codex') })
})

it('does not downgrade to legacy or PATH when the current release inventory or recorded CLI is broken', () => {
  const f = fixture(), primary = join(f.root, 'release-manifest.json'), paths = [primary, f.manifestPath]
  writeFileSync(primary, 'not json')
  expect(() => hostedBinaries(undefined, { manifestPath: paths, path: f.official })).toThrow()
  writeFileSync(primary, JSON.stringify({ ...f.manifest,
    original: { ...f.manifest.original, claude_code: { path: join(f.root, 'missing-claude'), sha256: 'a'.repeat(64) } },
  }))
  expect(() => hostedBinaries(undefined, { manifestPath: paths, path: f.official })).toThrow('recorded_cli_unavailable')
})
