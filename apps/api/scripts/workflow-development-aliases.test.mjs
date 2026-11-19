import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import test, { after } from 'node:test'
import { developmentWorkflowAliases, workflowDevelopmentAliases } from '../workflow-development-aliases.mjs'
import { nodeRuntimePackages } from '../build-contract.mjs'

const execute = promisify(execFile)
const root = resolve(import.meta.dirname, '../../..')

// The SDK uses cwd/.swc for its native plugin cache, not rootDir/workspaceDir.
// Each Node test worker needs its own cache; parallel writers can truncate a
// cache file while another process is loading it. Keep this for the whole file.
const previousCwd = process.cwd()
const compilerCwd = await mkdtemp(join(tmpdir(), 'mikka-workflow-alias-compiler-'))
process.chdir(compilerCwd)
after(async () => {
  process.chdir(previousCwd)
  await rm(compilerCwd, { recursive: true, force: true })
})
async function directory() {
  await mkdir(join(root, '.cache'), { recursive: true })
  return mkdtemp(join(root, '.cache/workflow-dev-alias-'))
}

test('native step imports compile workspace protocol and keep API adapters and package singletons across rebuilds', async () => {
  const temporary = await directory(), buildDir = join(temporary, 'build')
  try {
    await mkdir(join(buildDir, 'workflow'), { recursive: true })
    const filename = join(buildDir, 'workflow/steps.mjs')
    const source = version => `
      import { NextResponse } from '@/lib/server-runtime/server';
      import { headers } from '@/lib/server-runtime/headers';
      import { cache, createElement } from 'react';
      import { createRequestScope, runRequestScope } from '@/apps/api/src/context';
      import { trace } from '@opentelemetry/api';
      import { after } from '@/lib/server-runtime/server';
      import { ACCOUNT_ROUTES, connectedAccount } from '@mikka/protocol';
      import { telemetryId } from '@mikka/protocol/trace-context';
      import pg from 'pg';
      export { trace, pg, createElement, after, ACCOUNT_ROUTES, connectedAccount, telemetryId };
      export async function check() {
        let calls = 0; const memo = cache(() => ++calls);
        return runRequestScope(createRequestScope(new Request('http://localhost/fixture', { headers: { 'x-fixture': 'adapter' } })), async () => {
          const response = NextResponse.json({ version: ${version}, value: (await headers()).get('x-fixture'), memo: [memo(), memo()], basePath: process.env.MIKKA_BASE_PATH });
          return response.json();
        });
      }
    `
    const compile = developmentWorkflowAliases({ buildDir, replace: { 'process.env.MIKKA_BASE_PATH': JSON.stringify('/mikka') } })
    for (const version of [1, 2]) {
      await writeFile(filename, source(version))
      await compile()
      const completed = await readFile(filename)
      await compile()
      assert.deepEqual(await readFile(filename), completed, 'initial dev reload must not recompile an already completed artifact')
      const probe = join(temporary, `probe-${version}.mjs`)
      await writeFile(probe, `
        import assert from 'node:assert/strict'; import {trace} from '@opentelemetry/api'; import pg from 'pg'; import {createElement} from 'react'; import {z} from 'zod';
        const step = await import(${JSON.stringify(pathToFileURL(filename).href)});
        assert.equal(step.trace, trace); assert.equal(step.pg, pg); assert.equal(step.createElement, createElement); assert.equal(typeof step.after, 'function');
        assert.equal(step.ACCOUNT_ROUTES.list, '/v1/me/accounts'); assert.equal(step.telemetryId('run_1512'), true); assert.ok(step.connectedAccount instanceof z.ZodObject);
        assert.deepEqual(await step.check(), {version:${version}, value:'adapter', memo:[1,1], basePath:'/mikka'});
        console.log('native-aliases-ok');
      `)
      const result = await execute(process.execPath, [probe], { cwd: root, env: { ...process.env, NODE_OPTIONS: '' }, timeout: 20_000, maxBuffer: 64 * 1024 })
      assert.equal(result.stdout.trim(), 'native-aliases-ok')
    }
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('the actual Workflow LocalBuilder output loads natively and answers GET/HEAD health after the API alias pass', { timeout: 120_000 }, async () => {
  const temporary = await directory(), buildDir = join(temporary, 'build')
  try {
    await writeFile(join(temporary, 'package.json'), JSON.stringify({ name: 'mikka-workflow-dev-alias-fixture', type: 'module' }))
    await writeFile(join(temporary, 'fixture.ts'), `
      import { NextResponse } from '@/lib/server-runtime/server';
      import { ACCOUNT_ROUTES } from '@mikka/protocol';
      export async function aliasStep() {
        'use step';
        return NextResponse.json({route:ACCOUNT_ROUTES.list}).status;
      }
      export async function aliasWorkflow() {
        'use workflow';
        return await aliasStep();
      }
    `)
    const require = createRequire(import.meta.resolve('workflow/nitro'))
    const { LocalBuilder } = await import(pathToFileURL(join(dirname(require.resolve('@workflow/nitro')), 'builders.js')).href)
    const builder = new LocalBuilder({ options: { rootDir: temporary, workspaceDir: temporary, buildDir, dev: true,
      workflow: { dirs: ['.'], sourcemap: false }, externals: { external: nodeRuntimePackages } } })
    await builder.build()
    // The upstream builder follows the application's `@/` prefix into the real
    // module, so the step carries the server runtime's own imports. The
    // development pass below then has a graph Node can load as-is.
    const built = await readFile(join(buildDir, 'workflow/steps.mjs'), 'utf8')
    assert.ok(built.includes('aliasStep'), 'the fixture step reached the bundle')
    assert.ok(!built.includes('@/lib/server-runtime/'), 'the alias is no longer left for Node to resolve')
    assert.match(built, /NextResponse/, 'the step keeps the server response type it imports')
    const compile = developmentWorkflowAliases({ buildDir })
    await compile()
    const probe = join(temporary, 'health.mjs')
    await writeFile(probe, `
      import assert from 'node:assert/strict';
      const steps = await import(${JSON.stringify(pathToFileURL(join(buildDir, 'workflow/steps.mjs')).href)});
      // The SDK registers steps in a global map instead of exporting them. Call
      // the step itself: only that proves the aliased server runtime — and the
      // NextResponse it builds — is loadable inside the Workflow world.
      const registered = globalThis[Symbol.for('@workflow/core//registeredSteps')];
      const aliasStep = registered.get('step//./fixture//aliasStep');
      assert.equal(await aliasStep(), 200, 'the aliased NextResponse answers the step');
      const {POST} = await import(${JSON.stringify(pathToFileURL(join(buildDir, 'workflow/workflows.mjs')).href)});
      for (const method of ['GET','HEAD']) {
        const response = await POST(new Request('http://localhost/.well-known/workflow/v1/flow?__health', {method}));
        assert.equal(response.status,200); assert.equal((await response.json()).healthy,true);
      }
      console.log('native-workflow-health-ok');
    `)
    const result = await execute(process.execPath, [probe], { cwd: root, env: { ...process.env, NODE_OPTIONS: '', WORKFLOW_TARGET_WORLD: 'local', WORKFLOW_LOCAL_DATA_DIR: join(temporary, 'world') }, timeout: 30_000, maxBuffer: 64 * 1024 })
    assert.equal(result.stdout.trim(), 'native-workflow-health-ok')
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('production builds register no extra pass; dev registers after both SDK build phases', () => {
  const hooks = []
  const nitro = dev => ({ options: { dev, buildDir: '/unused' }, hooks: { hook: (name, callback) => hooks.push([name, callback]) } })
  workflowDevelopmentAliases(nitro(false)); assert.equal(hooks.length, 0)
  workflowDevelopmentAliases(nitro(true)); assert.deepEqual(hooks.map(([name]) => name), ['build:before', 'dev:reload'])
})
