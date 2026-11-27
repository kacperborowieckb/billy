import { authorizedFetch } from "./mcp-authorized-fetch.ts";
import type { McpAuthorizedFetchInput } from "./mcp-authorized-fetch.ts";
import type { SealedCredentials } from "./sealed-credentials.ts";
import { SealedOAuthProvider } from "./sealed-oauth-provider.ts";

export interface McpServerRegistrationInput extends McpAuthorizedFetchInput {
  readonly credentials: SealedCredentials;
}

export const serverRegistrationOf = ({
  credentials,
  ...request
}: McpServerRegistrationInput) => ({
  url: request.entry.serverUrl,
  name: request.entry.displayName,
  transport: {
    type: "streamable-http" as const,
    fetch: authorizedFetch(request),
    authProvider: new SealedOAuthProvider(
      credentials,
      request.entry.catalogId,
      "Billy"
    ),
  },
});
