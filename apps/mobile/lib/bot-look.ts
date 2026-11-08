// A bot's colour and shape ids, shared by the default bot avatar and the hosted layer's (docs/ui-overlay.md).

/** The web's twelve bot colours (lib/bot-shapes.ts BOT_COLORS), in its order. */
export const BOT_COLORS: Record<string, string> = {
  encre: '#0a0a0c', brun: '#8b5e3c', rouge: '#e8483f', orange: '#f08a24', ambre: '#f0b429', vert: '#3ecf8e',
  turquoise: '#2fbfa0', bleu: '#3b93f0', violet: '#8b5cf6', rose: '#e152b0', gris: '#a3a3a3', creme: '#d9d5ca',
}

export type BotShapeDrawing = 'circle' | 'squircle' | 'flower' | 'cloud' | 'cat' | 'drop'

/** The web's sixteen bloub shapes, drawn still with the nearest of six. */
export const BOT_SHAPE_DRAWINGS: Record<string, BotShapeDrawing> = {
  cercle: 'circle', galet: 'circle', coeur: 'circle', champignon: 'circle', fantome: 'circle', feuille: 'drop',
  squircle: 'squircle', capsule: 'squircle', triangle: 'squircle', hexagone: 'squircle', ecran: 'squircle',
  nuage: 'cloud', goutte: 'drop', fleur: 'flower', etoile: 'flower', chat: 'cat',
}

/** The shapes 新建 Bot offers: one per drawing the app has, as the web names them. */
export const BOT_PICKER_SHAPES = ['cercle', 'squircle', 'nuage', 'goutte', 'fleur', 'chat'] as const

/** The colour a bot is drawn in: unknown ids fall back to ink, and ink is drawn crème in dark mode, as on the web. */
export function botFill(color: string | null | undefined, dark: boolean): string {
  const known = color && BOT_COLORS[color] ? color : 'encre'
  return BOT_COLORS[known === 'encre' && dark ? 'creme' : known]
}
