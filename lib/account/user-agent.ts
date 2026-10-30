/**
 * A short, readable name for the device behind a session's User-Agent, such as
 * 「Chrome · macOS」 or 「Mikka · iPhone」. Only the parts a person recognises
 * are kept; versions are dropped. Unknown parts come back as null so the UI can
 * fall back to its own wording.
 */
export interface DeviceDescription {
  /** The app or browser: 'Mikka', 'Chrome', 'Safari', 'Edge', 'Firefox', 'Opera', 'Arc'… */
  client: string | null
  /** The system: 'macOS', 'Windows', 'iPhone', 'iPad', 'Android', 'Linux', 'ChromeOS'. */
  os: string | null
  /** 'Chrome · macOS'; whichever part is known when the other is not; null when neither is. */
  label: string | null
  /** The Mikka iOS app rather than a browser. */
  app: boolean
}

const MAX_USER_AGENT = 1024

// Order matters: Edge and Opera also say Chrome; Chrome also says Safari.
const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\b(?:OPR|Opera|OPT)\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\b(?:Firefox|FxiOS)\//, 'Firefox'],
  [/\bArc\//, 'Arc'],
  [/\bBrave\//, 'Brave'],
  [/\b(?:Chrome|CriOS|Chromium)\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
  [/\bAppleWebKit\/.*\bMobile\//, 'Safari'],
]

const SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\biPhone\b/, 'iPhone'],
  [/\biPad\b/, 'iPad'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
]

// The iOS app's own requests: React Native's networking sends
// "Mikka/<build> CFNetwork/… Darwin/…" (or "Expo/…" in Expo Go). The app ships
// for iPhone only (apps/mobile/app.json supportsTablet: false).
const IOS_APP = /^(?:Mikka|Expo)\/\S+ CFNetwork\/\S+ Darwin\//

export function describeUserAgent(userAgent: string | null | undefined): DeviceDescription {
  const ua = (userAgent ?? '').slice(0, MAX_USER_AGENT).trim()
  if (!ua) return { client: null, os: null, label: null, app: false }
  if (IOS_APP.test(ua)) return { client: 'Mikka', os: 'iPhone', label: 'Mikka · iPhone', app: true }
  const client = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1] ?? null
  const os = SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1] ?? null
  const label = [client, os].filter(Boolean).join(' · ') || null
  return { client, os, label, app: false }
}
