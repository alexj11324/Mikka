/**
 * Settings surface policy.
 *
 * A settings field is a row, never a tinted box. This check catches the
 * pattern that started the rule: a `bg-muted`(or accent/secondary) plus a
 * `rounded-*` radius on the same element inside a settings-like surface.
 *
 * The subject card (one agent, one device) is allowed as long as it has no
 * background colour; the rule targets the field inside it.
 *
 * See docs/settings.md for the full contract.
 */
const SETTINGS_ROOTS = ['components/settings/', 'components/agents/', 'components/devices/']
const TINT = /\bbg-(?:muted|accent|secondary)(?:\/\d+)?\b/
const RADIUS = /\brounded-(?:xs|sm|md|lg|xl|2xl|3xl|4xl|full)\b/
const CLASS_ATTR = /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{["']([^"']*)["']\})/g

export function auditSettingsSurface(file, text) {
  if (!SETTINGS_ROOTS.some(root => file.startsWith(root))) return []
  const diagnostics = []
  text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(CLASS_ATTR)) {
      const value = match[1] ?? match[2] ?? match[3] ?? ''
      if (!TINT.test(value) || !RADIUS.test(value)) continue
      diagnostics.push({
        file,
        line: index + 1,
        column: (match.index ?? 0) + 1,
        rule: 'settings/field-surface',
        message: '设置字段不能加底色或圆角：改用 SettingRow / SettingsSection，行之间用 divide-y。见 docs/settings.md。',
      })
    }
  })
  return diagnostics
}
