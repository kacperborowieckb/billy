import { Schema } from "effect";

import type { FetchFunction } from "./mcp-outbound-guard.ts";
import { withinDeadline } from "./oauth-deadline.ts";
import type { StoredTokens } from "./sealed-credentials.ts";

const TokenResponseSchema = Schema.Struct({
  access_token: Schema.NonEmptyString,
  token_type: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Number),
  scope: Schema.optionalKey(Schema.String),
  account_name: Schema.optionalKey(Schema.String),
  workspace_name: Schema.optionalKey(Schema.String),
});

const decodeTokenResponse = Schema.decodeUnknownSync(TokenResponseSchema);

export class TokenExchangeFailedError extends Error {
  override readonly name = "TokenExchangeFailedError";
}

export interface TokenExchangeInput {
  readonly send: FetchFunction;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly clientSecret: string | undefined;
  readonly redirectUrl: string;
  readonly serverUrl: string;
  readonly code: string;
  readonly codeVerifier: string;
}

export interface TokenExchangeResult {
  readonly tokens: StoredTokens;
  readonly accountLabel: string | undefined;
}

const maxAccountLabelCharacters = 80;

const accountLabelOf = (...candidates: readonly (string | undefined)[]) => {
  const label = candidates
    .map((candidate) =>
      (candidate ?? "").replaceAll(/[\p{C}\p{Z}]+/gu, " ").trim()
    )
    .find((candidate) => candidate.length > 0);
  return label?.slice(0, maxAccountLabelCharacters);
};

export const exchangeCode = async ({
  send,
  tokenEndpoint,
  clientId,
  clientSecret,
  redirectUrl,
  serverUrl,
  code,
  codeVerifier,
}: TokenExchangeInput): Promise<TokenExchangeResult> => {
  try {
    const response = await withinDeadline(async (signal) => {
      const answer = await send(tokenEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUrl,
          client_id: clientId,
          ...(clientSecret === undefined
            ? {}
            : { client_secret: clientSecret }),
          code_verifier: codeVerifier,
          resource: serverUrl,
        }),
        signal,
      });
      if (!answer.ok) {
        throw new TokenExchangeFailedError(
          "The token endpoint refused the code"
        );
      }
      return decodeTokenResponse(await answer.json<unknown>());
    });
    if (response.token_type.toLowerCase() !== "bearer") {
      throw new TokenExchangeFailedError("The token type is not Bearer");
    }
    const {
      account_name: accountName,
      workspace_name: workspaceName,
      token_type: _tokenType,
      ...granted
    } = response;
    return {
      tokens: { ...granted, token_type: "Bearer" },
      accountLabel: accountLabelOf(accountName, workspaceName),
    };
  } catch {
    throw new TokenExchangeFailedError("The token exchange failed");
  }
};
