/** The space between two rows of a chat. */
export const CHAT_ROW_GAP = 12

/** A first guess at a row's height before it is measured; chat rows vary, so the list measures each. */
export const CHAT_LIST_ESTIMATED_ROW = 120

/** How close to the end still counts as reading the latest message. */
export const AT_LATEST_SLACK = 80

/** Whether the end of the chat is within `AT_LATEST_SLACK` of the bottom of the view. */
export function isAtLatest(offset: number, contentHeight: number, viewportHeight: number) {
  return contentHeight - viewportHeight - offset <= AT_LATEST_SLACK
}
