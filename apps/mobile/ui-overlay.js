// The hosted UI layer for the iOS app (docs/ui-overlay.md, 「iOS app」).
// Without MIKKA_MOBILE_OVERLAY_DIR every `@ui-slot/<name>` import is its
// default in slots/; with it, a slot resolves to the layer's slots/<name>.tsx
// (required), and `@hosted/*` to the layer's own files. The layer's
// other imports resolve as if from this app, so it shares this app's react,
// react-native and react-native-svg. metro.config.js reads this.
const { existsSync, realpathSync, statSync } = require('node:fs')
const { isAbsolute, join, relative, resolve } = require('node:path')

/** Every native slot required of an official mobile layer. */
const MOBILE_SLOTS = ['bot-avatar']
/** The names every slot must export, in a layer as in the default. */
const MOBILE_SLOT_EXPORTS = { 'bot-avatar': ['BotAvatar'] }
const SLOT_PREFIX = '@ui-slot/'
const HOSTED_PREFIX = '@hosted/'

const inside = (root, path) => {
  const rel = relative(root, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Where each slot resolves for this build. The directory is relative to the
 * repository root (CI uses `.hosted-ui/mobile`, gitignored) and must sit inside
 * it, where Metro watches. A missing directory fails the bundle.
 */
function mobileOverlay(app, env = process.env) {
  const repository = resolve(app, '../..')
  const configured = env.MIKKA_MOBILE_OVERLAY_DIR?.trim()
  const slots = Object.fromEntries(MOBILE_SLOTS.map(name => [name, join(app, 'slots', `${name}.tsx`)]))
  if (!configured) return { dir: null, slots }
  const dir = resolve(repository, configured)
  if (!existsSync(dir)) throw new Error(`MOBILE_OVERLAY_DIR_MISSING: ${configured}`)
  if (!inside(realpathSync(repository), realpathSync(dir))) throw new Error(`MOBILE_OVERLAY_DIR_OUTSIDE_REPOSITORY: ${configured}`)
  for (const name of MOBILE_SLOTS) {
    const file = join(dir, 'slots', `${name}.tsx`)
    if (!existsSync(file) || !statSync(file).isFile() || !inside(realpathSync(dir), realpathSync(file))) throw new Error(`MOBILE_SLOT_REQUIRED: ${name}`)
    slots[name] = file
  }
  return { dir, slots }
}

/** A Metro `resolveRequest` that applies the layer, then hands on to `next` (or Metro's own resolver). */
function overlayResolver(app, env = process.env, next) {
  const { dir, slots } = mobileOverlay(app, env)
  const fromApp = join(app, 'package.json')
  return (context, moduleName, platform) => {
    const resolveNext = (ctx, name) => (next ?? ctx.resolveRequest)(ctx, name, platform)
    if (moduleName.startsWith(SLOT_PREFIX)) {
      const file = slots[moduleName.slice(SLOT_PREFIX.length)]
      if (!file) throw new Error(`MOBILE_SLOT_UNKNOWN: ${moduleName}`)
      return { type: 'sourceFile', filePath: file }
    }
    if (moduleName.startsWith(HOSTED_PREFIX)) {
      if (!dir) throw new Error(`MOBILE_OVERLAY_IMPORT_WITHOUT_OVERLAY: ${moduleName}`)
      return resolveNext(context, join(dir, moduleName.slice(HOSTED_PREFIX.length)))
    }
    if (dir && inside(dir, context.originModulePath) && !moduleName.startsWith('.') && !isAbsolute(moduleName)) {
      return resolveNext({ ...context, originModulePath: fromApp }, moduleName)
    }
    return resolveNext(context, moduleName)
  }
}

module.exports = { HOSTED_PREFIX, MOBILE_SLOTS, MOBILE_SLOT_EXPORTS, SLOT_PREFIX, mobileOverlay, overlayResolver }
