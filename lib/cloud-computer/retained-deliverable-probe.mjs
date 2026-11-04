const quote = value => `'${value.replaceAll("'", "'\\''")}'`
/** The source is the traced, unchanged private script, not a bundled function's
 * toString(). Scope is a JSON argument and can never become executable code. */
export function retainedDeliverableProbeCommand(source, input) {
  return `/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C /opt/mikka/runtime/node/bin/node --input-type=module -e ${quote(source)} -- --mikka-retained-delivery-probe ${quote(Buffer.from(JSON.stringify(input), 'utf8').toString('base64url'))}`
}
