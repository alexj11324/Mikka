// The color keys a label may hold. Mirrors LABEL_COLORS in packages/ui, which
// owns the Tailwind classes (`apps/server/src/mcp/label-colors.test.ts` keeps
// the two lists equal). The database stores the key, never a raw color, so the
// server can validate a color without depending on the renderer package.
export const LABEL_COLOR_KEYS = [
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "violet",
  "pink",
] as const

export type LabelColorKey = (typeof LABEL_COLOR_KEYS)[number]
