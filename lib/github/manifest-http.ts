import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { logCodedError } from '@mikka/protocol/coded-error'
import { resolveAppOrigin } from '@/lib/auth-config'
import { isServerAdmin } from '@/lib/server-admin'
import { noteLogUser } from '@/lib/request-log'
import { GitHubAppSetupError, type GitHubAppConfig, type GitHubAppCredentials, type GitHubAppQuery } from './app-config'
import { githubAppInstallUrlFromSlug } from './install-url'
import { readGitHubAppMetadata } from './app-metadata'
import {
  consumeGitHubAppManifest, exchangeGitHubAppManifest, githubAppManifest, githubManifestAction, githubManifestOrganization, githubManifestStateMatches,
  startGitHubAppManifest, GITHUB_MANIFEST_CALLBACK, GITHUB_MANIFEST_COOKIE, GITHUB_MANIFEST_SETTINGS, GITHUB_MANIFEST_TTL_MS,
  type GitHubAppTemplate,
} from './manifest'

const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' }
type Session = { user: { id: string }; session: { id: string } } | null
type Dependencies = {
  query: GitHubAppQuery
  session: (headers: Headers) => Promise<Session>
  config: () => Promise<GitHubAppConfig>
  save: (credentials: GitHubAppCredentials, userId: string) => Promise<void>
  template: GitHubAppTemplate | null
  env?: Readonly<Record<string, string | undefined>>
  fetcher?: typeof fetch
}
const configured = (config: GitHubAppConfig) => Boolean(config.id || config.pem)

/** Only the configured deployment origin can receive new server credentials. Forwarded headers are not configuration. */
export function githubManifestOrigin(request: Request, env: Readonly<Record<string, string | undefined>>): string {
  const value = resolveAppOrigin(env)
  let origin: URL
  try { origin = new URL(value ?? '') }
  catch (error) { throw new GitHubAppSetupError('origin', 400, error) }
  if (origin.origin !== value || !['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password
    || new URL(request.url).origin !== origin.origin) throw new GitHubAppSetupError('origin', 403)
  return origin.origin
}

function failed(error: unknown, viewerId?: string, admin?: boolean): Response {
  if (!(error instanceof GitHubAppSetupError)) throw error
  logCodedError(error)
  return Response.json({ ...(viewerId ? { viewerId } : {}), ...(admin === undefined ? {} : { admin }), error: error.code, detail: error.detail }, { status: error.status, headers })
}

/** Shared by the production routes and the real PostgreSQL acceptance suite. */
export function githubManifestHandlers({ query, session, config, save, template, env = process.env, fetcher = fetch }: Dependencies) {
  async function viewer(request: Request) {
    const current = await session(request.headers)
    noteLogUser(current?.user.id)
    return current
  }

  async function GET(request: Request): Promise<Response> {
    const current = await viewer(request)
    if (!current) return Response.json({ error: 'authRequired' }, { status: 401, headers })
    const viewerId = current.user.id
    if (!isServerAdmin(viewerId, env)) return Response.json({ viewerId, admin: false }, { headers })
    try {
      const app = await config()
      if (new URL(request.url).searchParams.get('metadata') === '1') return Response.json({ viewerId, admin: true, metadata: await readGitHubAppMetadata(app, fetcher) }, { headers })
      // No credential, state or OAuth identifier is returned by this status endpoint.
      return Response.json({ viewerId, admin: true, configured: configured(app), slug: app.slug, installUrl: configured(app) ? githubAppInstallUrlFromSlug(app.slug) : null }, { headers })
    } catch (error) { return failed(error, viewerId, true) }
  }

  async function POST(request: Request): Promise<Response> {
    const current = await viewer(request)
    if (!current) return Response.json({ error: 'authRequired' }, { status: 401, headers })
    const viewerId = current.user.id
    try {
      if (!isServerAdmin(viewerId, env)) throw new GitHubAppSetupError('admin', 403)
      const origin = githubManifestOrigin(request, env)
      if (request.headers.get('origin') !== origin) throw new GitHubAppSetupError('origin', 403)
      if (configured(await config())) throw new GitHubAppSetupError('configured', 409)
      if (!template) throw new GitHubAppSetupError('template', 503)
      const body = await request.text()
      if (body.length > 1_024) throw new GitHubAppSetupError('request', 400)
      let input: unknown
      try { input = JSON.parse(body) } catch (error) { throw new GitHubAppSetupError('request', 400, error) }
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'organization')) throw new GitHubAppSetupError('request', 400)
      const organization = githubManifestOrganization((input as { organization?: unknown }).organization)
      const manifest = githubAppManifest({ origin, template })
      const state = await startGitHubAppManifest(query, { userId: viewerId, sessionId: current.session.id, origin }, { env })
      const response = NextResponse.json({ viewerId, manifest, action: githubManifestAction(state, organization) }, { headers })
      response.cookies.set(GITHUB_MANIFEST_COOKIE, state, { httpOnly: true, secure: origin.startsWith('https:'), sameSite: 'lax', path: GITHUB_MANIFEST_CALLBACK, maxAge: GITHUB_MANIFEST_TTL_MS / 1_000 })
      return response
    } catch (error) { return failed(error, viewerId) }
  }

  async function callback(request: Request): Promise<Response> {
    // A bad configured origin cannot choose a redirect destination.
    let origin: string
    try { origin = githubManifestOrigin(request, env) }
    catch (error) { return failed(error) }
    let result = 'created'
    try {
      const current = await viewer(request)
      if (!current || !isServerAdmin(current.user.id, env)) throw new GitHubAppSetupError('admin', 403)
      const search = new URL(request.url).searchParams
      const state = search.get('state')
      const cookie = new NextRequest(request).cookies.get(GITHUB_MANIFEST_COOKIE)?.value
      if (!githubManifestStateMatches(state, cookie)
        || !await consumeGitHubAppManifest(query, { state, userId: current.user.id, sessionId: current.session.id, origin })) throw new GitHubAppSetupError('state', 400)
      if (configured(await config())) throw new GitHubAppSetupError('configured', 409)
      const credentials = await exchangeGitHubAppManifest(search.get('code') ?? '', fetcher)
      await save(credentials, current.user.id)
    } catch (error) {
      if (!(error instanceof GitHubAppSetupError)) throw error
      logCodedError(error)
      result = error.detail ?? 'default'
    }
    const back = new URL(GITHUB_MANIFEST_SETTINGS, origin)
    back.searchParams.set('github-app', result)
    const response = NextResponse.redirect(back, { status: 303, headers })
    response.cookies.set(GITHUB_MANIFEST_COOKIE, '', { httpOnly: true, secure: origin.startsWith('https:'), sameSite: 'lax', path: GITHUB_MANIFEST_CALLBACK, maxAge: 0 })
    return response
  }
  return { GET, POST, callback }
}
