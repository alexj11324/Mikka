export interface ApprovalPrincipal {authenticator:string;principalType:string;principalId:string;attributes?:Record<string,unknown>}
export interface ApprovalScope {ownerId:string;botId:string;workspaceId:string;surface:'web'|'slack'}

/** Native Eve authentication supplies these identities, never model input. */
export function isEveApprovalResponder(scope:ApprovalScope,principal:ApprovalPrincipal|null|undefined):boolean {
  return principal?.authenticator==='mikka'&&principal.principalType==='user'&&principal.principalId===scope.ownerId&&principal.attributes?.botId===scope.botId&&principal.attributes.workspaceId===scope.workspaceId&&principal.attributes.surface===scope.surface
}
