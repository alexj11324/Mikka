import { defaultAgentCopy as agentCopy } from '@/lib/agent-copy'
import type { OpenUIError, ParseResult } from '@openuidev/lang-core'

export type AgentUIIssue = { title: string; message: string }

const componentNames: Record<string, string> = {
  Table: agentCopy.table, ShadcnTable: agentCopy.table, BeTable: agentCopy.table, Col: agentCopy.tableColumn,
  BeImage: agentCopy.illustration, BeImageCard: agentCopy.illustratedCard, BeCardGrid: agentCopy.recommendationCard, BeCard: agentCopy.contentCard,
  BeQuestions: agentCopy.questionCard, BeApproval: agentCopy.confirmationCard, BeTodoList: agentCopy.taskList,
  Form: agentCopy.form, FormControl: agentCopy.formField, Input: agentCopy.input,
  Tabs: agentCopy.tabs, ShadcnTabs: agentCopy.tabs, BeTabs: agentCopy.tabs, TextContent: agentCopy.textParagraph, BeResponse: agentCopy.responseContent,
}

export function getAgentUIIssue(result: ParseResult | null, runtimeErrors: OpenUIError[] = []): AgentUIIssue | null {
  if (!result) return { title: agentCopy.unableToReadResponse, message: agentCopy.theModelReturnedAnInvalidFormatThis }
  if (result.meta.unresolved.length > 0) return {
    title: agentCopy.responseContentIsMissing,
    message: (agentCopy.theModelReferenced + (result.meta.unresolved.length) + agentCopy.contentSectionsWithoutReturningThemReceivedContent),
  }
  const error = [...result.meta.errors, ...runtimeErrors].find(issue => issue.severity !== 'warning')
  if (error) {
    const component = error.component ? componentNames[error.component] ?? agentCopy.contentComponent : agentCopy.contentComponent
    if (error.code === 'unknown-component' || error.code === 'unknown-function') return {
      title: agentCopy.someContentCannotBeDisplayed, message: agentCopy.theModelUsedAnUnsupportedComponentThe,
    }
    if (error.code === 'no-root' || error.code === 'parse-failed' || error.code === 'parse-exception') return {
      title: agentCopy.unableToReadResponse, message: agentCopy.theModelDidNotReturnTextOr,
    }
    if (error.code === 'render-error' || error.code === 'runtime-error') return {
      title: agentCopy.someContentFailedToDisplay, message: (agentCopy.the + (component) + agentCopy.inThisResponseFailedToDisplayThe),
    }
    return { title: agentCopy.someContentCannotBeDisplayed, message: (agentCopy.theModelReturnedInvalidDataFor + (component) + agentCopy.ThisPartCannotBeDisplayedThe) }
  }
  if (!result.root) return { title: agentCopy.noDisplayableContent, message: agentCopy.theModelReturnedNoDisplayableTextOr }
  return null
}
