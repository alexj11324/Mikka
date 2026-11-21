import type { AgentCopy } from '@/lib/agent-copy'
import { ClipboardList, FileText, GitCompareArrows, Layers } from '@/components/icons'

export const getAgentStarters = (agentCopy: AgentCopy) => [
  { title: agentCopy.breakDownAProject, description: agentCopy.turnAnIdeaIntoClearPhasesAnd, icon: Layers, prompt: agentCopy.helpMeBreakANewProjectInto },
  { title: agentCopy.organizeATaskList, description: agentCopy.organizeTodosAndPrioritizeNextSteps, icon: ClipboardList, prompt: agentCopy.helpMeOrganizeMyNextStepsInto },
  { title: agentCopy.draftAWeeklyReport, description: agentCopy.summarizeProjectProgressInAConciseWeekly, icon: FileText, prompt: agentCopy.draftAWeeklyProjectReportCoveringProgress },
  { title: agentCopy.compareApproaches, icon: GitCompareArrows, prompt: agentCopy.compareImplementationApproachesByCostComplexityAnd },
]
