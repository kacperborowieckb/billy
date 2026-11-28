import { Schema } from "effect";

import { failureReasonOf } from "./mcp-failure.ts";
import type { FetchFunction } from "./mcp-outbound-guard.ts";
import { withinDeadline } from "./oauth-deadline.ts";
import type { StoredTokens } from "./sealed-credentials.ts";

export const TokenResponseSchema = Schema.Struct({
  access_token: Schema.NonEmptyString,
  token_type: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Number),
  scope: Schema.optionalKey(Schema.String),
  account_name: Schema.optionalKey(Schema.String),
  workspace_name: Schema.optionalKey(Schema.String),
});

export const decodeTokenResponse =
  Schema.decodeUnknownSync(TokenResponseSchema);

export class TokenExchangeFailedError extends Error {
  override readonly name = "TokenExchangeFailedError";

  readonly reason: string;

  readonly httpStatus: number | undefined;

  constructor(reason: string, httpStatus?: number) {
    super("The token exchange failed");
    this.reason = reason;
    this.httpStatus = httpStatus;
  }
}

export interface TokenExchangeInput {
  readonly send: FetchFunction;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly clientAuthentication:
    | { readonly method: "basic" | "post"; readonly secret: string }
    | undefined;
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
  clientAuthentication,
  redirectUrl,
  serverUrl,
  code,
  codeVerifier,
}: TokenExchangeInput): Promise<TokenExchangeResult> => {
  try {
    const answered = await withinDeadline(async (signal) => {
      const answer = await send(tokenEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          ...(clientAuthentication?.method === "basic"
            ? {
                Authorization: `Basic ${btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientAuthentication.secret)}`)}`,
              }
            : {}),
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUrl,
          client_id: clientId,
          ...(clientAuthentication?.method === "post"
            ? { client_secret: clientAuthentication.secret }
            : {}),
          code_verifier: codeVerifier,
          resource: serverUrl,
        }),
        signal,
      });
      return {
        ok: answer.ok,
        status: answer.status,
        body: answer.ok ? await answer.json<unknown>() : undefined,
      };
    });
    if (!answered.ok) {
      throw new TokenExchangeFailedError("refused", answered.status);
    }
    const response = decodeTokenResponse(answered.body);
    if (response.token_type.toLowerCase() !== "bearer") {
      throw new TokenExchangeFailedError("token_type_not_bearer");
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
  } catch (error) {
    throw error instanceof TokenExchangeFailedError
      ? error
      : new TokenExchangeFailedError(failureReasonOf(error));
  }
};
