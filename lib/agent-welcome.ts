/**
 * A bot speaks first (Grok style): a chat with no turns yet asks it for a
 * welcome. The turn is stored with this prompt, which the chat never shows as
 * a message of the person's.
 */
export const WELCOME_PROMPT = '[[welcome]]'

/** What the model is told in place of WELCOME_PROMPT. */
export function welcomeInstruction(personName: string, locale: string) {
  const language = locale.startsWith('zh') ? 'Simplified Chinese' : 'English'
  return `The person${personName ? ` (${personName})` : ''} has just created you and opened your chat. Speak first, in ${language}. `
    + 'Root = Stack([TextContent(...), BeQuestions(...)]): one short TextContent greeting them by first name, saying who you are and, in one sentence, what kinds of everyday work you can take on; '
    + 'then one BeQuestions with a single question asking what they want help with first, four short options, allowCustom true. No other components, no headings, no follow-ups.'
}

/** Marks the Coordinator's welcome request in its conversation, which the chat never shows. */
export const COORDINATOR_WELCOME_MARK = '[Welcome]'

/**
 * The Coordinator speaks first too, like every bot: an empty chat asks it for
 * a welcome. Its replies are Markdown unless they start with `root =`, so the
 * OpenUI shape is spelled out.
 */
export function coordinatorWelcome(personName: string, locale: string) {
  const language = locale.startsWith('zh') ? 'Simplified Chinese' : 'English'
  return `${COORDINATOR_WELCOME_MARK} The person${personName ? ` (${personName})` : ''} has just opened their chat with you for the first time. Speak first, in ${language}. `
    + 'Reply with exactly this OpenUI shape and nothing else, filling in the quoted parts:\n'
    + 'root = Stack([TextContent("<one short greeting by first name: you are their Coordinator, you hand work to agents and bots and keep track of it>"), '
    + 'BeQuestions("<one line of context>", [{id:"start", title:"<ask what they want to start with>", options:[{value:"a", label:"<option>"}, {value:"b", label:"<option>"}, {value:"c", label:"<option>"}, {value:"d", label:"<option>"}], allowCustom:true}])])'
}
