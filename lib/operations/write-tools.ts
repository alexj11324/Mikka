import { tool, type ToolExecutionOptions } from 'ai'
import { writeSchemas, type WriteActionName } from './write-contract'
/** Host Coordinator owns registration and durable intent allocation. Model input
 * contains only proposed content/target; never owner, connection or approval. */
export function createApprovedWriteTools(propose: (action: WriteActionName, input: unknown, options: ToolExecutionOptions<unknown>) => Promise<unknown>) {
  return {
    append_notion_paragraph: tool({ description: 'Propose appending exactly one plain paragraph to the selected Notion page. Requires a separate human approval; nothing is written now.', inputSchema: writeSchemas.append_notion_paragraph, execute: (input, options) => propose('append_notion_paragraph', input, options) }),
    send_slack_message: tool({ description: 'Propose one literal message to the specified Slack channel. No mentions or link previews. Requires human approval; nothing is sent now.', inputSchema: writeSchemas.send_slack_message, execute: (input, options) => propose('send_slack_message', input, options) }),
    cancel_calendar_event: tool({ description: 'Propose canceling the specified primary-calendar event, explicitly choosing whether attendees are notified. Requires human approval; no cancellation occurs now.', inputSchema: writeSchemas.cancel_calendar_event, execute: (input, options) => propose('cancel_calendar_event', input, options) }),
  }
}
