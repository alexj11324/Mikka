// Deliverable previews: an HTML page an agent wrote, opened inside the app.
// The page is untrusted, so it never runs on the app's own origin. Electron
// main serves it on its own scheme (`mikka-preview:`); the renderer shows it
// in an iframe with `sandbox="allow-scripts"`. The page gets an opaque origin,
// inline scripts and styles, and no network: it cannot reach the app, the
// bridge, the session, or the internet.
import { z } from "zod"

export const PREVIEW_SCHEME = "mikka-preview"

/** Largest page the app will preview (bytes of UTF-16 text, roughly). */
export const PREVIEW_MAX_LENGTH = 5 * 1024 * 1024

export const previewHtml = z.string().max(PREVIEW_MAX_LENGTH)

const DIRECTIVES = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "base-uri 'none'",
  "form-action 'none'",
]

/** CSP header for a preview page. `sandbox` makes its origin opaque. */
export const PREVIEW_CSP_HEADER = ["sandbox allow-scripts", ...DIRECTIVES].join(
  "; "
)

const META = `<meta http-equiv="Content-Security-Policy" content="${DIRECTIVES.join("; ")}">`

/**
 * The page with its CSP as the first element, so the policy also holds where
 * headers are not applied (the browser shim's blob: URL). Policies only add
 * up: nothing later in the page can loosen it. Goes after a leading doctype
 * so the page keeps standards mode.
 *
 * A meta CSP is defense-in-depth, not isolation: it cannot sandbox the page.
 * Callers must still load previews through `mikka-preview:` or an iframe with
 * `sandbox="allow-scripts"` and no `allow-same-origin`.
 */
export function withPreviewCsp(html: string): string {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0] ?? ""
  return doctype + META + html.slice(doctype.length)
}
