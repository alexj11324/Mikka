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
