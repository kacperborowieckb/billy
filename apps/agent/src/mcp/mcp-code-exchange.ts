import { DateTime } from "effect";

import type { McpCatalogEntry } from "./mcp-catalog.ts";
import { failureReasonOf, logMcpFailure } from "./mcp-failure.ts";
import type { FetchFunction } from "./mcp-outbound-guard.ts";
import type { PendingOAuth } from "./oauth-start.ts";
import {
  latestExchangeKey,
  settledOAuthKeyPrefix,
} from "./oauth-storage-keys.ts";
import {
  exchangeCode,
  TokenExchangeFailedError,
} from "./oauth-token-exchange.ts";
import type { SealedCredentials } from "./sealed-credentials.ts";

const settledLifetimeMillis = 15 * 60 * 1000;

export interface CodeExchangeDependencies {
  readonly send: FetchFunction;
  readonly storage: DurableObjectStorage;
  readonly credentials: (ownerId: string) => Promise<SealedCredentials>;
}

export type CodeExchangeOutcome =
  | { readonly _tag: "Failed" }
  | { readonly _tag: "Exchanged"; readonly label: string | undefined };

export interface CodeExchangeRequest {
  readonly entry: McpCatalogEntry;
  readonly pending: PendingOAuth;
  readonly nonce: string;
  readonly code: string;
}

export const exchangeAndStore = async (
  dependencies: CodeExchangeDependencies,
  { entry, pending, nonce, code }: CodeExchangeRequest
): Promise<CodeExchangeOutcome> => {
  try {
    const credentials = await dependencies.credentials(pending.ownerId);
    const clientSecret =
      pending.sealedClientSecret === undefined
        ? undefined
        : await credentials.openClientSecret(
            entry.catalogId,
            nonce,
            pending.sealedClientSecret
          );
    const exchanged = await exchangeCode({
      send: dependencies.send,
      tokenEndpoint: pending.tokenEndpoint,
      clientId: pending.clientId,
      clientAuthentication:
        clientSecret === undefined
          ? undefined
          : {
              method: pending.clientAuthMethod ?? "basic",
              secret: clientSecret,
            },
      redirectUrl: pending.redirectUrl,
      serverUrl: entry.serverUrl,
      code,
      codeVerifier: await credentials.openVerifier(
        entry.catalogId,
        nonce,
        pending.sealedCodeVerifier
      ),
    });
    await dependencies.storage.put({
      ...(await credentials.sealedEntries(entry.catalogId, exchanged.tokens, {
        client_id: pending.clientId,
        ...(clientSecret === undefined
          ? {}
          : {
              client_secret: clientSecret,
              client_auth_method: pending.clientAuthMethod ?? "basic",
            }),
        redirectUrl: pending.redirectUrl,
        tokenEndpoint: pending.tokenEndpoint,
        ...(pending.revocationEndpoint === undefined
          ? {}
          : { revocationEndpoint: pending.revocationEndpoint }),
      })),
      [latestExchangeKey(entry.catalogId)]: nonce,
      [`${settledOAuthKeyPrefix}${nonce}`]: {
        ownerId: pending.ownerId,
        catalogId: entry.catalogId,
        issuer: pending.issuer,
        issuerIsRequired: pending.issuerIsRequired,
        ...(exchanged.accountLabel === undefined
          ? {}
          : { accountLabel: exchanged.accountLabel }),
        expiresAtMillis:
          DateTime.toEpochMillis(DateTime.nowUnsafe()) + settledLifetimeMillis,
      },
    });
    return { _tag: "Exchanged", label: exchanged.accountLabel };
  } catch (error) {
    await logMcpFailure({
      phase: "token_exchange",
      catalogId: entry.catalogId,
      ...(error instanceof TokenExchangeFailedError
        ? {
            reason: error.reason,
            ...(error.httpStatus === undefined
              ? {}
              : { httpStatus: error.httpStatus }),
          }
        : { reason: failureReasonOf(error) }),
    });
    return { _tag: "Failed" };
  }
};
