import { tool } from "ai";
import {
  credentialToolDefinitions,
  type CredentialToolName,
} from "./execution-tools";

/** Same schemas for chat and Coordinator; execute is always server-authenticated and scoped. */
export function createCredentialAITools(
  execute: (name: CredentialToolName, input: unknown) => Promise<unknown>,
) {
  return {
    prepare_credential_request: tool({
      ...credentialToolDefinitions.prepare_credential_request,
      execute: (input) => execute("prepare_credential_request", input),
    }),
    credential_status: tool({
      ...credentialToolDefinitions.credential_status,
      execute: (input) => execute("credential_status", input),
    }),
    credential_use: tool({
      ...credentialToolDefinitions.credential_use,
      execute: (input) => execute("credential_use", input),
    }),
    credential_browser_action: tool({
      ...credentialToolDefinitions.credential_browser_action,
      execute: (input) => execute("credential_browser_action", input),
    }),
    credential_finish: tool({
      ...credentialToolDefinitions.credential_finish,
      execute: (input) => execute("credential_finish", input),
    }),
  };
}
