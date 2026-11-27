import { Option, Schema } from "effect";

import type { FetchFunction } from "./mcp-outbound-guard.ts";
import { withinDeadline } from "./oauth-deadline.ts";
import { decodeTokenResponse } from "./oauth-token-exchange.ts";
import type { StoredClient, StoredTokens } from "./sealed-credentials.ts";

export interface TokenRefreshInput {
  readonly send: FetchFunction;
  readonly client: StoredClient;
  readonly tokenEndpoint: string;
  readonly refreshToken: string;
  readonly serverUrl: string;
}

export type TokenRefreshOutcome =
  | { readonly _tag: "Refreshed"; readonly tokens: StoredTokens }
  | { readonly _tag: "Rejected"; readonly httpStatus: number }
  | { readonly _tag: "Unavailable"; readonly httpStatus: number | undefined };

interface TokenAnswer {
  readonly status: number;
  readonly text: string;
}

const terminalErrors = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
]);

const ErrorBodySchema = Schema.fromJsonString(
  Schema.Struct({ error: Schema.String })
);

const errorCodeOf = (text: string) =>
  Option.getOrUndefined(
    Option.map(
      Schema.decodeUnknownOption(ErrorBodySchema)(text),
      (body) => body.error
    )
  );

const isTerminalRefusal = ({ status, text }: TokenAnswer) =>
  (status === 400 || status === 401) &&
  terminalErrors.has(errorCodeOf(text) ?? "");

const tokensOf = (text: string): StoredTokens => {
  const response = decodeTokenResponse(JSON.parse(text));
  if (response.token_type.toLowerCase() !== "bearer") {
    throw new Error("The token type is not Bearer");
  }
  return {
    access_token: response.access_token,
    token_type: "Bearer",
    ...(response.refresh_token === undefined
      ? {}
      : { refresh_token: response.refresh_token }),
    ...(response.expires_in === undefined
      ? {}
      : { expires_in: response.expires_in }),
    ...(response.scope === undefined ? {} : { scope: response.scope }),
  };
};

const clientSecretOf = ({ client }: TokenRefreshInput) =>
  client.client_secret === undefined
    ? undefined
    : {
        method: client.client_auth_method ?? "basic",
        secret: client.client_secret,
      };

const requestOf = (input: TokenRefreshInput, signal: AbortSignal) => {
  const { client, refreshToken, serverUrl } = input;
  const authentication = clientSecretOf(input);
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      ...(authentication?.method === "basic"
        ? {
            Authorization: `Basic ${btoa(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(authentication.secret)}`)}`,
          }
        : {}),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: client.client_id,
      ...(authentication?.method === "post"
        ? { client_secret: authentication.secret }
        : {}),
      resource: serverUrl,
    }),
    signal,
  };
};

export const refreshTokens = async (
  input: TokenRefreshInput
): Promise<TokenRefreshOutcome> => {
  let answer: TokenAnswer;
  try {
    answer = await withinDeadline(async (signal) => {
      const response = await input.send(
        input.tokenEndpoint,
        requestOf(input, signal)
      );
      return { status: response.status, text: await response.text() };
    });
  } catch {
    return { _tag: "Unavailable", httpStatus: undefined };
  }
  if (answer.status >= 200 && answer.status < 300) {
    try {
      return { _tag: "Refreshed", tokens: tokensOf(answer.text) };
    } catch {
      return { _tag: "Unavailable", httpStatus: answer.status };
    }
  }
  return isTerminalRefusal(answer)
    ? { _tag: "Rejected", httpStatus: answer.status }
    : { _tag: "Unavailable", httpStatus: answer.status };
};
