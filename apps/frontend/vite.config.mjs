import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { applicationPlugin, frontend, repository } from './scripts/application-plugin.mjs'
import { deploymentPlugin, pinnedUrl } from './scripts/deployment-plugin.mjs'
import { configuredDeploymentId } from '../../lib/deployment-id.mjs'
import { deploymentStage } from '../../lib/deployment-stage.mjs'
import { installationBuild } from '../../scripts/build-installation.mjs'
import { sharedStylePlugins } from './scripts/shared-styles.mjs'

function applicationBuild() {
  const configured = process.env.NEXT_PUBLIC_MIKKA_BUILD ?? process.env.MIKKA_BUILD_REVISION ?? process.env.VERCEL_DEPLOYMENT_ID ?? process.env.VERCEL_GIT_COMMIT_SHA
  if (configured !== undefined) return configured
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' }
}

export async function frontendConfig({ target = 'web', command = 'build', outdir, clean = true, serverPages = false, publicTestFixture = false } = {}) {
  if (!['web', 'desktop'].includes(target)) throw new Error('FRONTEND_TARGET_INVALID')
  if (!['build', 'serve'].includes(command)) throw new Error('FRONTEND_COMMAND_INVALID')
  const stage = deploymentStage()
  const development = command === 'serve'
  const directory = process.env.MIKKA_UI_OVERLAY_DIR?.trim()
  const selected = directory || process.env.MIKKA_UI_OVERLAY_SHA?.trim()
  if (serverPages && (target !== 'web' || selected || publicTestFixture)) throw new Error('SERVER_PAGES_REQUIRE_PUBLIC_WEB_BUILD')
  if (publicTestFixture && (selected || process.env.VERCEL_ENV === 'production')) throw new Error('PUBLIC_FIXTURE_REQUIRES_NON_RELEASE_BUILD')
  if (!publicTestFixture && !(development && directory && !process.env.MIKKA_UI_OVERLAY_SHA)) {
    const mode = await installationBuild({ ...process.env, MIKKA_UI_OVERLAY_DIR: directory && resolve(repository, directory) })
    if (target === 'desktop' && mode === 'build:server') throw new Error('OFFICIAL_DESKTOP_UI_CHECKOUT_REQUIRED')
    serverPages = mode === 'build:server'
  }
  const deploymentId = target === 'web' && !development ? configuredDeploymentId() ?? '' : ''
  return {
    configFile: false,
    root: frontend,
    base: '/mikka/',
    publicDir: resolve(repository, 'public'),
    // Never auto-export VITE_* or load a developer/backend credential file.
    envDir: false,
    envPrefix: [],
    logLevel: 'warn',
    define: {
      'process.env.NODE_ENV': JSON.stringify(development ? 'development' : 'production'),
      'process.env.MIKKA_BASE_PATH': '"/mikka"',
      'process.env.NEXT_PUBLIC_MIKKA_BUILD': JSON.stringify(target === 'web' && !development ? applicationBuild() : ''),
      'process.env.MIKKA_DEPLOYMENT_ID': JSON.stringify(deploymentId),
      // This is the existing explicitly public anti-bot widget key. Desktop
      // never imports its browser auth forms or third-party script loader.
      'process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY': JSON.stringify(target === 'web' ? process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '' : ''),
      'process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY': JSON.stringify(target === 'web' ? process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? '' : ''),
      'process.env.POSTHOG_HOST': JSON.stringify(target === 'web' ? process.env.POSTHOG_HOST ?? '' : ''),
      'process.env.NEXT_PUBLIC_POSTHOG_HOST': JSON.stringify(target === 'web' ? process.env.POSTHOG_HOST ?? process.env.NEXT_PUBLIC_POSTHOG_HOST ?? '' : ''),
      'process.env.NEXT_PUBLIC_POSTHOG_KEY': JSON.stringify(target === 'web' ? process.env.NEXT_PUBLIC_POSTHOG_KEY ?? '' : ''),
      'process.env.NEXT_PUBLIC_COMPUTER_ACCEPTANCE': JSON.stringify(target === 'web' ? process.env.NEXT_PUBLIC_COMPUTER_ACCEPTANCE ?? '' : ''),
      'process.env.NEXT_PUBLIC_COMPUTER_DEPLOYMENT': JSON.stringify(target === 'web' ? stage ?? '' : ''),
      'process.env.NEXT_PUBLIC_COMPUTER_ENABLED': JSON.stringify(target === 'web' ? process.env.NEXT_PUBLIC_COMPUTER_ENABLED ?? '' : ''),
      'process.env.NEXT_PUBLIC_COMPUTER_MOCK': JSON.stringify(target === 'web' ? process.env.NEXT_PUBLIC_COMPUTER_MOCK ?? '' : ''),
      'process.env.NEXT_PUBLIC_MIKKA_DAEMON_PACKAGE_NAME': JSON.stringify(target === 'web' ? process.env.NEXT_PUBLIC_MIKKA_DAEMON_PACKAGE_NAME ?? '@aspectlylabs/mikka' : ''),
      'process.env': '{}',
    },
    plugins: [await applicationPlugin(target, { deploymentId, serverPages, publicTestFixture }), react(), await deploymentPlugin({ repository, deploymentId })],
    experimental: deploymentId ? { renderBuiltUrl: filename => pinnedUrl(`/mikka/${filename}`, deploymentId) } : {},
    // A hosted UI layer (docs/ui-overlay.md) may carry its own node_modules; React stays this repository's.
    resolve: { dedupe: ['react', 'react-dom'] },
    css: { postcss: { plugins: sharedStylePlugins(repository, { development }) } },
    build: {
      outDir: outdir ?? resolve(frontend, `dist/${target}`),
      emptyOutDir: clean,
      target: target === 'desktop' ? 'chrome130' : 'baseline-widely-available',
      sourcemap: false,
      // The preceding pass already uses the existing web minifier/targets.
      cssMinify: false,
      manifest: true,
      reportCompressedSize: false,
      rolldownOptions: {
        onwarn(warning, defaultHandler) {
          // "use client" is a boundary in the server compiler. Every module
          // here is already browser-only, and server imports fail above.
          if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('use client')) return
          defaultHandler(warning)
        },
      },
    },
  }
}

export default defineConfig(({ command, mode }) => frontendConfig({ command, target: mode === 'desktop' ? 'desktop' : 'web' }))
