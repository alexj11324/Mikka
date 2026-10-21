export const ACTION_ERROR_CODES = [
  'generic',
  'authRequired',
  'validationGeneric',
  'validationTitleRequired',
  'validationDocument',
  'validationNameRequired',
  'issueNotFound',
  'issueRevisionInvalid',
  'issueStale',
  'issueSaveFailed',
  'issueMoveInvalid',
  'memberOwnerOnly',
  'memberInvalidEmail',
  'memberNotRegistered',
  'deviceNameTooLong',
  'deviceNotFound',
  'agentHarnessMissing',
  'agentDuplicateName',
  'agentInvalidInput',
  'agentAddFailed',
  'agentSaveFailed',
  'agentNotFound',
  'agentNoDevice',
  'agentRepoMissing',
  'repoPathInvalid',
  'repoNotFound',
  'runInvalid',
  'runNotFound',
  'messageRequired',
  'deviceSaveFailed',
  'tokenCreateFailed',
  'documentPending',
] as const

export type ActionErrorCode = (typeof ACTION_ERROR_CODES)[number]

export type ActionErrorParams = Record<string, string | number>

export interface ActionFailure {
  error: ActionErrorCode
  params?: ActionErrorParams
}

export type ActionResult<T> = (T & { error?: undefined }) | ActionFailure
