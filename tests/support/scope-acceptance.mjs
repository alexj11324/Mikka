/** Propagate the original subtest exception after node:test has recorded it.
 * Awaiting t.test alone does not fail the containing test or stop later calls. */
export async function scopeSubtest(context, name, callback) {
  let failure, failed = false
  await context.test(name, async child => {
    try { await callback(child) }
    catch (error) { failure = error; failed = true; throw error }
  })
  if (failed) { globalThis.scopeAcceptance?.abort(failure); throw failure }
}
