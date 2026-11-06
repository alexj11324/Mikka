/** Match the installed Next RequestCookies semantics without changing the raw
 * Cookie header used by authentication: the last valid value wins, malformed
 * percent encoding is ignored, and an attribute without '=' has value 'true'.
 * Do not trim names, strip quotes, replace '+', or partially decode bad input.
 * @param {string | null} header
 * @returns {Map<string, string>}
 */
export function parseRequestCookies(header) {
  const values = new Map()
  for (const pair of (header ?? '').split(/; */)) {
    if (!pair) continue
    const separator = pair.indexOf('=')
    if (separator === -1) { values.set(pair, 'true'); continue }
    try { values.set(pair.slice(0, separator), decodeURIComponent(pair.slice(separator + 1))) }
    catch { /* A malformed later value must not erase an earlier valid value. */ }
  }
  return values
}
