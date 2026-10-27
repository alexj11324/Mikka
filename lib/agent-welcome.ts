/** Marks a bot's welcome request in its conversation, which the chat never shows. */
export const COORDINATOR_WELCOME_MARK = '[Welcome]'

/**
 * A bot speaks first (Grok style), the Coordinator included: an empty chat
 * asks it for a welcome. Its replies are Markdown unless they start with
 * `root =`, so the OpenUI shape is spelled out. `botName` is a bot the person
 * just made; without it this is the Coordinator.
 */
export function coordinatorWelcome(personName: string, locale: string, botName?: string) {
  const language = locale.startsWith('zh') ? 'Simplified Chinese' : 'English'
  const who = botName ? `you are ${botName}, the bot they just made, and say in one sentence what everyday work you can take on` : 'you are their Coordinator, you hand work to agents and bots and keep track of it'
  return `${COORDINATOR_WELCOME_MARK} The person${personName ? ` (${personName})` : ''} has just opened their chat with you for the first time. Speak first, in ${language}. `
    + 'Reply with exactly this OpenUI shape and nothing else, filling in the quoted parts:\n'
    + `root = Stack([TextContent("<one short greeting by first name: ${who}>"), `
    + 'BeQuestions("<one line of context>", [{id:"start", title:"<ask what they want to start with>", options:[{value:"a", label:"<option>"}, {value:"b", label:"<option>"}, {value:"c", label:"<option>"}, {value:"d", label:"<option>"}], allowCustom:true}])])'
}
