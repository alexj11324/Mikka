import { bindRequestCallback, requireRequestScope } from '../src/context'
import { CookieJar } from '../src/cookies'

type NextConfig = { basePath?: string }
export class NextURL extends URL {
  basePath: string
  constructor(input: string | URL, options: { nextConfig?: NextConfig } = {}) {
    super(input)
    const prefix = options.nextConfig?.basePath ?? '/mikka'
    this.basePath = prefix && (super.pathname === prefix || super.pathname.startsWith(`${prefix}/`)) ? prefix : ''
    if (this.basePath) super.pathname = super.pathname.slice(this.basePath.length) || '/'
  }
  override get href(): string {
    const value = new URL(super.href)
    value.pathname = this.basePath + (super.pathname === '/' ? '' : super.pathname) || '/'
    return value.href
  }
  override set href(value: string) { super.href = value }
  override toString(): string { return this.href }
  override toJSON(): string { return this.href }
  clone(): NextURL { return new NextURL(this.href, { nextConfig: { basePath: this.basePath } }) }
}

export class NextRequest extends Request {
  readonly nextUrl: NextURL
  readonly cookies: CookieJar
  constructor(input: RequestInfo | URL, options: RequestInit & { nextConfig?: NextConfig; duplex?: 'half' } = {}) {
    const url = input instanceof Request ? input.url : String(input)
    const { nextConfig, ...init } = options
    let source = input
    // srvx NodeRequest is a Request-compatible adapter, but its private Undici
    // state belongs to the SDK's documented native backing request. Leave the
    // outer object (runtime/abort/waitUntil) in the real request scope untouched.
    if (input instanceof Request && '_request' in input) {
      const canonical = (input as Request & { _url?: URL })._url
      if (canonical && canonical.href !== url) throw new TypeError('API_REQUEST_URL_MISMATCH')
      if (input.bodyUsed && init.body == null) throw new TypeError('API_REQUEST_BODY_USED')
      source = (input as Request & { _request?: Request })._request ?? input
      if (source instanceof Request && source.url !== url) throw new TypeError('API_REQUEST_URL_MISMATCH')
    }
    super(source, { duplex: 'half', ...init } as RequestInit)
    this.nextUrl = new NextURL(url, { nextConfig })
    this.cookies = new CookieJar(this.headers.get('cookie'), value => this.headers.set('cookie', value))
  }
}

export class NextResponse<_Body = unknown> extends Response {
  private jar?: CookieJar
  get cookies(): CookieJar {
    if (!this.jar) {
      this.jar = new CookieJar(null, undefined, (name, encoded) => {
        const retained = this.headers.getSetCookie().filter(value => !value.startsWith(`${name}=`))
        this.headers.delete('set-cookie')
        for (const value of retained) this.headers.append('set-cookie', value)
        this.headers.append('set-cookie', encoded)
      })
    }
    return this.jar
  }
  static override json<Body>(body: Body, init?: ResponseInit): NextResponse<Body> {
    const response = Response.json(body, init)
    // srvx materializes a response after headers are accessed by spreading its
    // init. Response getters are not own properties, so copy the HTTP fields.
    return new NextResponse<Body>(response.body, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    })
  }
  static override redirect(url: string | URL, init: number | ResponseInit = 307): NextResponse {
    const options = typeof init === 'number' ? { status: init } : init
    const status = options.status ?? 307
    if (![301, 302, 303, 307, 308].includes(status)) throw new RangeError('Invalid redirect status code')
    const headers = new Headers(options.headers)
    headers.set('location', new URL(String(url)).toString())
    return new NextResponse(null, { ...options, status, headers })
  }
  static next(init?: ResponseInit): NextResponse {
    const headers = new Headers(init?.headers); headers.set('x-middleware-next', '1')
    return new NextResponse(null, { ...init, headers })
  }
  static rewrite(url: string | URL, init?: ResponseInit): NextResponse {
    const headers = new Headers(init?.headers); headers.set('x-middleware-rewrite', new URL(String(url)).toString())
    return new NextResponse(null, { ...init, headers })
  }
}
export function after(task: (() => unknown) | PromiseLike<unknown>): void {
  const scope = requireRequestScope()
  scope.after.add(typeof task === 'function' ? bindRequestCallback(task) : task)
}
