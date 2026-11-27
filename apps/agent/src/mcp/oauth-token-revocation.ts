import type { FetchFunction } from "./mcp-outbound-guard.ts";
import { clientAuthenticationOf } from "./oauth-client-authentication.ts";
import { withinDeadline } from "./oauth-deadline.ts";
import type { StoredClient, StoredTokens } from "./sealed-credentials.ts";

export type TokenRevocationOutcome = "revoked" | "failed";

export interface TokenRevocationInput {
  readonly send: FetchFunction;
  readonly client: StoredClient;
  readonly revocationEndpoint: string;
  readonly tokens: StoredTokens;
}

interface TokenToRevoke {
  readonly token: string;
  readonly hint: "access_token" | "refresh_token";
}

const tokensToRevoke = ({ tokens }: TokenRevocationInput) => [
  ...(tokens.refresh_token === undefined
    ? []
    : [
        { token: tokens.refresh_token, hint: "refresh_token" } as TokenToRevoke,
      ]),
  { token: tokens.access_token, hint: "access_token" } as TokenToRevoke,
];

const revokeOne = async (
  input: TokenRevocationInput,
  { token, hint }: TokenToRevoke
): Promise<TokenRevocationOutcome> => {
  const authentication = clientAuthenticationOf(input.client);
  try {
    const status = await withinDeadline(async (signal) => {
      const response = await input.send(input.revocationEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...authentication.headers,
        },
        body: new URLSearchParams({
          token,
          token_type_hint: hint,
          client_id: input.client.client_id,
          ...authentication.fields,
        }),
        signal,
      });
      await response.text();
      return response.status;
    });
    return status >= 200 && status < 300 ? "revoked" : "failed";
  } catch {
    return "failed";
  }
};

export const revokeTokens = async (
  input: TokenRevocationInput
): Promise<TokenRevocationOutcome> => {
  const outcomes = await Promise.all(
    tokensToRevoke(input).map((token) => revokeOne(input, token))
  );
  return outcomes.every((outcome) => outcome === "revoked")
    ? "revoked"
    : "failed";
};
