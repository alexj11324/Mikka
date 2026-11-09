/**
 * A brand mark's markup from @lobehub/icons-static-svg (MIT), ready for SvgXml: its `1em` size and inline style are
 * dropped so it takes the size it is given, and, as on the web, Codex's white rounded-square backdrop is left out so
 * the mark stands on its own in light and dark.
 */
export function agentMark(markup: string) {
  return markup
    .replace(/ (width|height)="1em"/g, '')
    .replace(/ style="[^"]*"/, '')
    .replace(/<path d="M19\.503 0H4\.496[^>]*fill="#fff"><\/path>/, '')
}
