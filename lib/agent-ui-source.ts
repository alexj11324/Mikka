/** Component names a reply may open with as its whole program, the library's catalog plus its root (lib/agent-ui-catalog.ts). */
const TOP_LEVEL_COMPONENTS = [
  'Stack', 'TextContent', 'BeCodeBlock', 'BeCard', 'BeCardGrid', 'BeImageCard', 'BeImage', 'BeButton',
  'BeFollowUps', 'BeBadge', 'BeStat', 'BeResponse', 'BeApproval', 'BeQuestions', 'BeTodoList', 'AgentIcon',
  'InlineText', 'TaskChip', 'RunChip', 'SourceChip', 'ComputerCard', 'ShadcnCard', 'ShadcnBadge', 'ShadcnAlert',
  'ShadcnProgress', 'ShadcnAccordion', 'ShadcnTabs', 'ShadcnTable', 'ShadcnButton', 'ReuiBadge', 'ReuiAlert', 'ReuiFrame',
]

/** `root = …`, where the prompt asks the model to put it (it may follow leading lines). */
const ROOT_ASSIGNMENT = /(?:^|\n)\s*root\s*=/

/**
 * A call at the very start, e.g. `Stack([…])`: a known component name, then
 * `(`, then something other than the empty call's `)`. Prose that merely
 * mentions a component ("Stack is …", "use Stack(…)") starts differently and
 * is left as Markdown.
 */
const TOP_LEVEL_CALL = new RegExp(`^\\s*(?:${TOP_LEVEL_COMPONENTS.join('|')})\\s*\\(\\s*[^\\s)]`)

/**
 * Whether a reply is OpenUI and the source to render. The prompt asks for
 * `root = Stack([…])`, but models sometimes drop `root =`; a reply that opens
 * with a component call gets it back. Both paths run the same escaping
 * normaliser, and prose that only names a component stays Markdown.
 */
export function detectAgentUISource(source: string): { isOpenUI: boolean; source: string } {
  if (ROOT_ASSIGNMENT.test(source)) return { isOpenUI: true, source: normalizeAgentUISource(source) }
  if (TOP_LEVEL_CALL.test(source)) return { isOpenUI: true, source: normalizeAgentUISource(`root = ${source.trimStart()}`) }
  return { isOpenUI: false, source }
}

export function normalizeAgentUISource(source: string): string {
  // OpenUI falls back to undecoded text if a double-quoted token is not valid JSON.
  return source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"?|'(?:\\[\s\S]|[^'\\])*'?/g, token => {
    if (!token.startsWith('"')) return token
    let result = '"'
    for (let index = 1; index < token.length; index++) {
      const character = token[index]
      if (character === '\\') {
        const next = token[index + 1]
        if (next === undefined) {
          result += character
        } else if (/^["\\/bfnrt]$/.test(next) || next === 'u' && /^[\da-f]{4}/i.test(token.slice(index + 2))) {
          result += character + next
          index++
        } else {
          result += '\\\\'
        }
      } else if (character.charCodeAt(0) < 32) {
        result += JSON.stringify(character).slice(1, -1)
      } else {
        result += character
      }
    }
    return result
  })
}
