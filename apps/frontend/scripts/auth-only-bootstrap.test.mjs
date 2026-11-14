import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { applicationPlugin } from './application-plugin.mjs'
import { Window } from 'happy-dom'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const renderer = resolve(repository, 'apps/desktop/src/renderer')
const web = resolve(repository, 'apps/frontend/src/web')
const require = createRequire(import.meta.url)
const directory = await mkdtemp(join(tmpdir(), 'mikka-auth-only-bootstrap-'))
const key = Symbol.for('mikka.test.auth-only-bootstrap')
const handoff = '/mikka/en/sign-in?desktop=1&desktop_state=abcdefghijklmnop&desktop_callback=http%3A%2F%2F127.0.0.1%3A4567%2Fauth%2Fcallback&desktop_next=%2F'
const stateAccess = 'globalThis[Symbol.for("mikka.test.auth-only-bootstrap")]'
const wrapper = '({ children }) => children'
const fixtureModules = new Map([
  ['next-intl', `export const NextIntlClientProvider = ${wrapper}; export const useTranslations = () => value => value; export const useLocale = () => 'en';`],
  ['lucide-react', 'export const ArrowLeft = () => null; export const ArrowRight = () => null; export const Plus = () => null; export const X = () => null;'],
  ['sonner', 'export const toast = { error() {}, dismiss() {} };'],
  ['@/messages/en.json', 'export default {};'], ['@/messages/zh-CN.json', 'export default {};'],
  ['@/components/theme-provider', `export const ThemeProvider = ${wrapper};`],
  ['@/components/swr-defaults', `export const SWRDefaults = ${wrapper};`],
  ['@/components/ui/sonner', 'export const Toaster = () => null;'],
  ['@/components/ui/button', `export const Button = ${wrapper}; export const buttonVariants = () => '';`],
  ['@/components/blocks/auth-19/components/auth', `export const Auth = ${wrapper};`],
  ['@/components/blocks/auth-19/components/auth-card', `export const AuthCard = ${wrapper};`],
  ['@/components/workspace/workspace-loading', 'import { createElement } from "react"; export const WorkspaceLoading = () => createElement("div", { "data-loading": true });'],
  ['@/components/workspace/create-workspace-form', 'export const CreateWorkspaceForm = () => null;'],
  ['@/components/workspace/invitation-card', `import { createElement } from 'react'; export const InvitationCard = () => createElement('div', { 'data-workspace-invitation': true }); export const OrganizationInvitationCard = () => createElement('div', { 'data-organization-invitation': true });`],
  ['@/components/device-authorization', 'export const DeviceAuthorization = () => null;'],
  ['@/components/plugins/github-settings', 'export const GitHubSettings = () => null;'],
  ['@/components/app-shell/not-found', 'export default () => null;'],
  ['@/components/auth-form', `import { createElement } from 'react'; import { useSWRConfig } from 'swr'; export const AuthForm = props => { ${stateAccess}.authCache = useSWRConfig().cache; return createElement('div', { 'data-auth': true, 'data-owner': props.signedInAs?.name ?? 'signed-out', 'data-handoff': Boolean(props.desktopFlow), 'data-email-enabled': props.emailEnabled }); };`],
  ['@/components/auth/forgot-password-form', 'export const ForgotPasswordForm = () => null;'],
  ['@/components/auth/reset-password-form', 'export const ResetPasswordForm = () => null;'],
  ['@/components/auth/verify-email-form', 'export const VerifyEmailForm = () => null;'],
  ['@/components/oauth-consent', 'export const OAuthConsent = () => null;'],
  ['@/components/version-guard', 'export const VersionGuard = () => null;'],
  ['@/components/posthog-analytics', 'export const PostHogAnalytics = () => null;'],
  ['@/components/plugins/github-settings', `import { createElement, useLayoutEffect } from 'react'; export const GitHubSettings = () => { useLayoutEffect(() => { ${stateAccess}.githubMounts++; }, []); return createElement('div', { 'data-github-handoff': true }); };`],
  ['@/lib/posthog-config', 'export const posthogConfig = { token: "" };'],
  ['@/lib/auth-client', `export const authClient = { $store: { atoms: { session: { subscribe: listener => ${stateAccess}.subscribe(listener) } } } }; export const cloudAuthClient = authClient;`],
  ['@/lib/swr/persistent-cache', `export const clearPersistentReadCaches = async () => { ${stateAccess}.cacheClears++; };`],
])
const application = await applicationPlugin('web')
const compiled = await build({
  absWorkingDir: repository,
  stdin: { contents: 'export { App } from "./app"; export { navigate, installNavigation, refresh } from "./location"; export { getClientConfiguration } from "./client-configuration"; export { getTransportState } from "./transport-state";', resolveDir: renderer, sourcefile: 'auth-only-contract.ts', loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2023', jsx: 'automatic', logLevel: 'silent',
  tsconfig: resolve(repository, 'apps/frontend/tsconfig.json'),
  define: { 'process.env.NODE_ENV': '"test"', 'process.env.MIKKA_BASE_PATH': '"/mikka"', 'process.env': '{}' },
  plugins: [{ name: 'auth-only-public-boundaries', setup(builder) {
    builder.onResolve({ filter: /^(?:react(?:\/.*)?|swr)$/ }, args => ({ path: require.resolve(args.path), external: true }))
    // Use the same client-side RPC modules as a production Web build.
    builder.onResolve({ filter: /^@\/app\/actions\/[\w-]+$/ }, async args => ({ path: await application.resolveId(args.path), namespace: 'web-action' }))
    builder.onLoad({ filter: /.*/, namespace: 'web-action' }, async args => ({ contents: await application.load(args.path), resolveDir: repository }))
    builder.onResolve({ filter: /^mikka:platform$/ }, () => ({ path: resolve(web, 'platform.tsx') }))
    builder.onResolve({ filter: /.*/ }, args => fixtureModules.has(args.path) ? { path: args.path, namespace: 'auth-fixture' } : undefined)
    builder.onResolve({ filter: /^(?:\.\/|\.\.\/).*rpc$/ }, args => {
      if (resolve(dirname(args.importer), args.path) === resolve(renderer, 'rpc') && args.importer !== resolve(web, 'rpc.ts')) return { path: resolve(web, 'rpc.ts') }
    })
    builder.onResolve({ filter: /^\.\/workspace$/ }, args => args.importer === resolve(renderer, 'workspace-loader.ts') ? { path: 'workspace', namespace: 'auth-fixture' } : undefined)
    builder.onResolve({ filter: /^\.\/offline$/ }, args => args.importer === resolve(renderer, 'app.tsx') ? { path: 'offline', namespace: 'auth-fixture' } : undefined)
    builder.onResolve({ filter: /^\.\/deep-link-routes$/ }, args => args.importer === resolve(renderer, 'app.tsx') ? { path: 'deep-links', namespace: 'auth-fixture' } : undefined)
    builder.onLoad({ filter: /.*/, namespace: 'auth-fixture' }, args => ({ loader: 'js', contents:
      args.path === 'workspace' ? `import { createElement, useLayoutEffect } from 'react'; export default function Workspace({ user, bootstrap }) { useLayoutEffect(() => { ${stateAccess}.workspaceMounts++; }, []); return createElement('div', { 'data-workspace': true, 'data-owner': user.id, 'data-role': bootstrap.cacheWorkspace?.role ?? 'none' }); }`
        : args.path === 'offline' ? 'import { createElement } from "react"; export const Offline = () => createElement("div", { "data-offline": true });'
          : args.path === 'deep-links' ? 'export const SharedArtifactRoute = () => null; export const WorkspaceLinkRoute = () => null;'
          : fixtureModules.get(args.path) }))
  } }],
})
const filename = join(directory, 'application.mjs')
await writeFile(filename, compiled.outputFiles[0].contents)
after(() => rm(directory, { recursive: true, force: true }))

const session = (id = 'owner', sessionId = 'session') => ({ user: { id, name: id, email: 'fixture@example.invalid', image: null }, session: { id: sessionId } })
const publicConfig = { googleEnabled: true, githubEnabled: false, emailEnabled: true, features: { flags: {}, cloudComputer: false }, daemonPackageName: '@aspectlylabs/mikka' }
const fullBootstrap = identity => ({ ...identity, ...publicConfig, features: { flags: {}, cloudComputer: true }, cacheWorkspace: { workspaceId: 'bf0f49e9-60ef-42a2-9e46-519b6010d7ef', role: 'member' }, onboarding: false })
const packet = result => Response.json({ version: 1, ok: true, result })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
let sequence = 0

async function fixture(t, { path = handoff, fetch: fetchResponse, desktopBridge = false, serverDocument } = {}) {
  const window = new Window({ url: `https://app.example${path}` })
  if (desktopBridge) window.mikka = { app: { runtime: 'electron' } }
  if (serverDocument) window.document.documentElement.dataset.mikkaServerPage = serverDocument
  const state = { identity: session(), requests: [], workspaceMounts: 0, githubMounts: 0, cacheClears: 0, listeners: new Set(),
    subscribe(listener) { this.listeners.add(listener); listener({ data: this.identity, isPending: false }); return () => this.listeners.delete(listener) } }
  const values = { window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, Node: window.Node,
    MutationObserver: window.MutationObserver, Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (path, init) => {
      const request = { path, action: init?.body ? JSON.parse(init.body).action : null, args: init?.body ? JSON.parse(init.body).args : null, location: window.location.pathname }
      state.requests.push(request)
      if (fetchResponse) { const response = await fetchResponse(request, state); if (response !== undefined) return response }
      if (path === '/mikka/api/desktop/config') return Response.json(publicConfig)
      assert.equal(path, '/mikka/api/rpc')
      if (request.action === 'desktop.session') return packet(state.identity)
      assert.equal(request.action, 'desktop.bootstrap')
      return packet(fullBootstrap(state.identity))
    } }
  const saved = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  globalThis[key] = state
  const api = await import(`${pathToFileURL(filename).href}?case=${++sequence}`)
  api.installNavigation()
  const container = window.document.createElement('div')
  window.document.body.appendChild(container)
  const root = createRoot(container)
  t.after(async () => {
    await act(() => root.unmount())
    await window.happyDOM.close()
    delete globalThis[key]
    for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name] }
  })
  await act(async () => root.render(createElement(api.App)))
  return { state, container, api, window,
    navigate: href => act(async () => api.navigate(href)),
    settle: () => act(async () => {}),
    owner: identity => act(async () => { state.identity = identity; for (const listener of state.listeners) listener({ data: identity, isPending: false }) }) }
}

test('a valid system-browser PKCE page reads only the existing session and public login methods', async t => {
  const f = await fixture(t)
  assert.ok(f.container.querySelector('[data-auth]'))
  assert.deepEqual(f.state.requests.filter(item => item.action).map(item => item.action), ['desktop.session'])
  assert.equal(f.state.requests.filter(item => item.path === '/mikka/api/desktop/config').length, 1)
  assert.equal(f.state.workspaceMounts, 0)
  assert.equal(f.container.querySelector('[data-auth]').getAttribute('data-owner'), 'owner')
})

test('a server authentication document preserves the PKCE identity-only boundary', async t => {
  const f = await fixture(t, { serverDocument: 'authentication' })
  assert.equal(f.container.querySelector('[data-auth]').getAttribute('data-owner'), 'owner')
  assert.deepEqual(f.state.requests.filter(item => item.action).map(item => item.action), ['desktop.session'])
  assert.equal(f.state.requests.filter(item => item.path === '/mikka/api/desktop/config').length, 1)
  assert.equal(f.state.workspaceMounts, 0)
  assert.equal(f.state.githubMounts, 0)
})

for (const [kind, prefix, card] of [
  ['Organization', '/organization-invite/', '[data-organization-invitation]'],
  ['Workspace', '/invite/', '[data-workspace-invitation]'],
]) {
  const invitation = prefix + 'b'.repeat(64)
  test(kind + ' invitations reach the account handoff even when workspace bootstrap is unavailable', async t => {
    const path = '/mikka/en' + invitation
    for (const [label, serverDocument] of [['official Web', undefined], ['Server-only', 'authentication']]) {
      await t.test(label, async t => {
        const f = await fixture(t, { path, serverDocument,
          fetch: request => request.action === 'desktop.bootstrap' ? new Response('', { status: 503 }) : undefined })
        assert.ok(f.container.querySelector(card))
        assert.equal(f.state.workspaceMounts, 0)
        assert.equal(f.state.githubMounts, 0)
        assert.deepEqual(f.state.requests.filter(item => item.action).map(item => item.action), ['desktop.session'])
        assert.equal(f.state.requests.filter(item => item.path === '/mikka/api/desktop/config').length, 1)
      })
    }
  })

  test('a signed-out account can sign in or register and return to its ' + kind + ' invitation during a workspace outage', async t => {
    for (const mode of ['sign-in', 'sign-up']) {
      await t.test(mode, async t => {
        let signedIn = false
        const f = await fixture(t, { path: `/mikka/en${invitation}`, fetch: request => {
          if (request.action === 'desktop.bootstrap') return new Response('', { status: 503 })
          if (request.action === 'desktop.session' && !signedIn) return packet(null)
        } })
        assert.ok(f.container.querySelector(card))
        await f.navigate(`/mikka/en/${mode}?next=${encodeURIComponent(invitation)}`)
        assert.equal(f.container.querySelector('[data-auth]')?.getAttribute('data-owner'), 'signed-out')
        signedIn = true
        await f.owner(session('invited-member', 'new-session'))
        await f.settle()
        assert.equal(f.window.location.pathname, `/mikka/en${invitation}`)
        assert.ok(f.container.querySelector(card))
        assert.equal(f.state.workspaceMounts, 0)
        assert.equal(f.state.requests.filter(item => item.action === 'desktop.bootstrap').length, 0)
      })
    }
  })
}

test('ordinary and ambiguous sign-in returns keep the existing workspace bootstrap', async t => {
  const next = encodeURIComponent(`/organization-invite/${'b'.repeat(64)}`)
  for (const [label, search] of [['settings', '?next=%2Fsettings'], ['duplicate next', `?next=${next}&next=${next}`],
    ['separate account flow', `?next=${next}&addAccount=1`], ['short invitation', '?next=%2Forganization-invite%2Fabc'],
    ['malformed Workspace invitation', '?next=%2Finvite%2Fabc'],
    ['ambiguous Workspace invitation', `?next=%2Finvite%2F${'a'.repeat(64)}&addAccount=1`]]) {
    await t.test(label, async t => {
      const f = await fixture(t, { path: `/mikka/en/sign-in${search}`, fetch: request =>
        request.action === 'desktop.bootstrap' ? new Response('', { status: 503 }) : undefined })
      assert.deepEqual(f.state.requests.filter(item => item.action).map(item => item.action), ['desktop.bootstrap'])
    })
  }
})

test('a signed-in server GitHub document renders only its handoff before and after intent cleanup', async t => {
  const path = '/mikka/en?section=plugins&app=github'
  const f = await fixture(t, { path: `${path}&intent=ghi_${'a'.repeat(43)}`, serverDocument: 'github' })
  assert.deepEqual(f.state.requests.filter(item => item.action).map(item => item.action), ['desktop.bootstrap'])
  assert.equal(f.state.requests.filter(item => item.path === '/mikka/api/desktop/config').length, 0)
  assert.ok(f.container.querySelector('[data-github-handoff]'))
  assert.equal(f.container.querySelector('[data-auth]'), null)
  assert.equal(f.state.workspaceMounts, 0)
  await f.navigate(path)
  assert.ok(f.container.querySelector('[data-github-handoff]'))
  assert.equal(f.state.githubMounts, 1)
  assert.equal(f.state.workspaceMounts, 0)
  assert.equal(f.state.requests.filter(item => item.action === 'desktop.bootstrap').length, 1)
})

test('a server GitHub document cannot bypass a rejected session', async t => {
  const f = await fixture(t, { path: '/mikka/en?section=plugins&app=github', serverDocument: 'github',
    fetch: request => request.action === 'desktop.bootstrap' ? new Response('', { status: 401 }) : undefined })
  assert.equal(f.container.querySelector('[data-auth]').getAttribute('data-owner'), 'signed-out')
  assert.equal(f.state.requests.filter(item => item.path === '/mikka/api/desktop/config').length, 1)
  assert.equal(f.state.githubMounts, 0)
  assert.equal(f.state.workspaceMounts, 0)
})

test('the official app without a server document marker keeps its normal workspace route', async t => {
  const f = await fixture(t, { path: '/mikka/en?section=plugins&app=github' })
  assert.ok(f.container.querySelector('[data-workspace]'))
  assert.equal(f.state.workspaceMounts, 1)
  assert.equal(f.state.githubMounts, 0)
})

test('Back to a different workspace waits for the authorized switch and never mounts a refused workspace', async t => {
  const workspace = 'bf0f49e9-60ef-42a2-9e46-519b6010d7ef'
  for (const accepted of [true, false]) await t.test(accepted ? 'active membership' : 'suspended membership', async t => {
    let selected = false
    const switching = deferred()
    const f = await fixture(t, { path: '/mikka/en?workspace=' + workspace, fetch: (request, state) => {
      if (request.action === 'desktop.bootstrap') return packet({ ...fullBootstrap(state.identity), requestedWorkspaceSelected: selected })
      assert.equal(request.action, 'workspace.switchWorkspace')
      assert.deepEqual(request.args, [workspace])
      return switching.promise
    } })
    assert.equal(f.state.workspaceMounts, 0, 'the old workspace stays unmounted while selection is pending')
    await act(async () => {
      selected = accepted
      switching.resolve(packet(accepted ? { ok: true } : { ok: false, error: 'Membership suspended' }))
    })
    assert.equal(f.state.workspaceMounts, accepted ? 1 : 0)
    assert.deepEqual(f.state.requests.filter(item => item.action).map(item => item.action), accepted
      ? ['desktop.bootstrap', 'workspace.switchWorkspace', 'desktop.bootstrap']
      : ['desktop.bootstrap', 'workspace.switchWorkspace'])
    if (!accepted) assert.match(f.container.textContent, /Common.retry/)
  })
})

test('leaving PKCE with the same null workspace selector requires fresh bootstrap before any workspace mounts', async t => {
  const ready = deferred()
  const f = await fixture(t, { fetch: request => request.action === 'desktop.bootstrap' && request.location === '/mikka/en/' ? ready.promise : undefined })
  assert.ok(f.container.querySelector('[data-auth]'))
  const previous = f.state.requests.filter(item => item.action === 'desktop.bootstrap').length
  await f.navigate('/mikka/en/')
  assert.equal(f.state.requests.filter(item => item.action === 'desktop.bootstrap').length, previous + 1)
  assert.equal(f.state.workspaceMounts, 0)
  assert.equal(f.container.querySelector('[data-workspace]'), null)
  await act(async () => ready.resolve(packet(fullBootstrap(f.state.identity))))
  assert.equal(f.state.workspaceMounts, 1)
  assert.equal(f.container.querySelector('[data-workspace]').getAttribute('data-role'), 'member')
  assert.equal(f.api.getClientConfiguration().features.cloudComputer, true)
})

test('malformed handoffs and an Electron-hosted page retain the ordinary full bootstrap', async t => {
  for (const options of [{ path: `${handoff}&desktop_state=duplicate-value` }, { desktopBridge: true }]) {
    await t.test(options.desktopBridge ? 'Electron host' : 'duplicate state', async t => {
      const f = await fixture(t, options)
      assert.deepEqual(f.state.requests.filter(item => item.action).map(item => item.action), ['desktop.bootstrap'])
      assert.equal(f.state.requests.filter(item => item.path === '/mikka/api/desktop/config').length, 0)
    })
  }
})

test('pending identity and workspace reads never join across phases or mount from a late identity result', async t => {
  const identity = deferred(), workspace = deferred()
  const f = await fixture(t, { fetch: request => request.action === 'desktop.session' ? identity.promise
    : request.action === 'desktop.bootstrap' ? workspace.promise : undefined })
  await f.navigate('/mikka/en/')
  await act(async () => { f.api.refresh(); f.api.refresh() })
  assert.deepEqual(f.state.requests.filter(item => item.action).map(item => item.action), ['desktop.session', 'desktop.bootstrap'])
  await act(async () => identity.resolve(packet(session())))
  assert.equal(f.state.workspaceMounts, 0)
  assert.equal(f.container.querySelector('[data-auth]'), null)
  assert.equal(f.container.querySelector('[data-workspace]'), null)
  await act(async () => workspace.resolve(packet(fullBootstrap(session()))))
  assert.equal(f.state.workspaceMounts, 1)
  assert.equal(f.container.querySelector('[data-workspace]').getAttribute('data-role'), 'member')
})

test('a late full bootstrap cannot replace a newly opened PKCE identity page or its anonymous configuration', async t => {
  const old = deferred()
  const f = await fixture(t, { path: '/mikka/en/', fetch: request => request.action === 'desktop.bootstrap' ? old.promise : undefined })
  await f.navigate(handoff)
  assert.equal(f.container.querySelector('[data-auth]').getAttribute('data-owner'), 'owner')
  assert.equal(f.api.getClientConfiguration().features.cloudComputer, false)
  await act(async () => old.resolve(packet(fullBootstrap(session('previous-owner')))))
  assert.equal(f.container.querySelector('[data-auth]').getAttribute('data-owner'), 'owner')
  assert.equal(f.state.workspaceMounts, 0)
  assert.equal(f.api.getClientConfiguration().features.cloudComputer, false)
})

test('a retired workspace request cannot expire or disconnect the current PKCE identity page', async t => {
  for (const status of [401, 503]) await t.test(String(status), async t => {
    const old = deferred()
    const f = await fixture(t, { path: '/mikka/en/', fetch: request => request.action === 'desktop.bootstrap' ? old.promise : undefined })
    await f.navigate(handoff)
    assert.equal(f.container.querySelector('[data-auth]').getAttribute('data-owner'), 'owner')
    await act(async () => old.resolve(new Response('', { status })))
    assert.equal(f.api.getTransportState(), 'ready')
    assert.equal(f.container.querySelector('[data-auth]').getAttribute('data-owner'), 'owner')
    assert.equal(f.state.workspaceMounts, 0)
  })
})

test('account and same-account session changes invalidate a pending identity response and clear prior caches', async t => {
  for (const nextOwner of ['other-owner', 'owner']) {
    await t.test(nextOwner === 'owner' ? 'same owner, new session' : 'different owner', async t => {
      const old = deferred()
      let reads = 0
      const f = await fixture(t, { fetch: request => request.action === 'desktop.session' && ++reads === 1 ? old.promise : undefined })
      const next = session(nextOwner, 'new-session')
      next.user.name = 'current identity'
      await f.owner(next)
      assert.equal(reads, 2)
      assert.ok(f.state.cacheClears > 0)
      assert.equal(f.container.querySelector('[data-auth]').getAttribute('data-owner'), 'current identity')
      await act(async () => old.resolve(packet(session())))
      assert.equal(f.container.querySelector('[data-auth]').getAttribute('data-owner'), 'current identity')
      assert.equal(f.state.workspaceMounts, 0)
      assert.ok(f.state.requests.every(item => item.action !== 'desktop.bootstrap'))
    })
  }
})

test('only a confirmed session expiry renders signed-out PKCE; network failure remains unavailable', async t => {
  for (const status of [401, 503]) await t.test(String(status), async t => {
    const f = await fixture(t, { fetch: request => request.action === 'desktop.session' ? new Response('', { status }) : undefined })
    assert.equal(f.state.requests.filter(item => item.path === '/mikka/api/desktop/config').length, 1)
    assert.ok(f.state.requests.every(item => item.action !== 'desktop.bootstrap'))
    if (status === 401) assert.equal(f.container.querySelector('[data-auth]').getAttribute('data-owner'), 'signed-out')
    else { assert.ok(f.container.querySelector('[data-offline]')); assert.equal(f.container.querySelector('[data-auth]'), null) }
    assert.equal(f.state.workspaceMounts, 0)
  })
})

test('a new session for the same owner retires the actual in-memory SWR cache', async t => {
  const f = await fixture(t)
  const old = f.state.authCache
  old.set('private-session-read', { data: 'previous-session-only' })
  await f.owner(session('owner', 'new-session'))
  assert.notEqual(f.state.authCache, old)
  assert.equal(f.state.authCache.get('private-session-read'), undefined)
  assert.equal(f.container.querySelector('[data-auth]').getAttribute('data-owner'), 'owner')
})
