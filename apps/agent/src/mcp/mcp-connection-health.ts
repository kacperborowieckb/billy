import { Effect, DateTime } from "effect";

import type { KeyedQueue } from "./keyed-queue.ts";
import type { McpCatalogEntry } from "./mcp-catalog.ts";
import type {
  McpConnectionLedger,
  McpErrorNote,
} from "./mcp-connection-ledger.ts";
import type { FetchFunction } from "./mcp-outbound-guard.ts";
import { refreshTokens } from "./oauth-token-refresh.ts";
import type { SealedCredentials, StoredTokens } from "./sealed-credentials.ts";

const expiryMarginMillis = 60_000;

export type AccessOutcome =
  | { readonly _tag: "Token"; readonly accessToken: string | undefined }
  | { readonly _tag: "SignInRequired" }
  | { readonly _tag: "NotConnected" }
  | { readonly _tag: "Unavailable" };

export interface McpConnectionHealthDependencies {
  readonly entryQueue: KeyedQueue;
  readonly ledger: McpConnectionLedger;
  readonly send: FetchFunction;
  readonly credentials: (ownerId: string) => Promise<SealedCredentials>;
  readonly tellNeedsSignIn: (
    ownerId: string,
    catalogId: string
  ) => Promise<void>;
}

interface Rejection {
  readonly entry: McpCatalogEntry;
  readonly ownerId: string;
  readonly rejectedAccessToken: string | undefined;
  readonly note: McpErrorNote;
}

const isExpiring = (tokens: StoredTokens) =>
  tokens.expires_at_millis !== undefined &&
  tokens.expires_at_millis - expiryMarginMillis <=
    DateTime.toEpochMillis(DateTime.nowUnsafe());

const token = (accessToken: string | undefined): AccessOutcome => ({
  _tag: "Token",
  accessToken,
});

const signInRequired: AccessOutcome = { _tag: "SignInRequired" };

const notConnected: AccessOutcome = { _tag: "NotConnected" };

const unavailable: AccessOutcome = { _tag: "Unavailable" };

export class McpConnectionHealth {
  private readonly dependencies: McpConnectionHealthDependencies;

  constructor(dependencies: McpConnectionHealthDependencies) {
    this.dependencies = dependencies;
  }

  async accessTokenFor(
    entry: McpCatalogEntry,
    ownerId: string
  ): Promise<AccessOutcome> {
    const credentials = await this.dependencies.credentials(ownerId);
    const tokens = await credentials.tokens(entry.catalogId);
    if (tokens === undefined || !isExpiring(tokens)) {
      const state = await this.dependencies.ledger.stateOf(entry.catalogId);
      return state === "needs_sign_in"
        ? signInRequired
        : token(tokens?.access_token);
    }
    return this.dependencies.entryQueue.run(entry.catalogId, () =>
      this.refreshInQueue(entry, ownerId, undefined)
    );
  }

  refreshWhileQueueHeld(
    entry: McpCatalogEntry,
    ownerId: string
  ): Promise<AccessOutcome> {
    return this.refreshInQueue(entry, ownerId, undefined);
  }

  async storedAccessToken(
    entry: McpCatalogEntry,
    ownerId: string
  ): Promise<AccessOutcome> {
    const credentials = await this.dependencies.credentials(ownerId);
    const tokens = await credentials.tokens(entry.catalogId);
    return token(tokens?.access_token);
  }

  recoverFromRejection(
    entry: McpCatalogEntry,
    ownerId: string,
    rejectedAccessToken: string | undefined
  ): Promise<AccessOutcome> {
    return this.dependencies.entryQueue.run(entry.catalogId, () =>
      this.refreshInQueue(entry, ownerId, rejectedAccessToken ?? "")
    );
  }

  confirmRejection({
    entry,
    ownerId,
    rejectedAccessToken,
    note,
  }: Rejection): Promise<AccessOutcome> {
    return this.dependencies.entryQueue.run(entry.catalogId, async () => {
      const credentials = await this.dependencies.credentials(ownerId);
      const tokens = await credentials.tokens(entry.catalogId);
      if (
        tokens !== undefined &&
        tokens.access_token !== (rejectedAccessToken ?? "")
      ) {
        return token(tokens.access_token);
      }
      return this.enterNeedsSignIn(entry, ownerId, note);
    });
  }

  private async enterNeedsSignIn(
    entry: McpCatalogEntry,
    ownerId: string,
    note: McpErrorNote
  ): Promise<AccessOutcome> {
    const { catalogId } = entry;
    const { ledger, tellNeedsSignIn } = this.dependencies;
    const state = await ledger.stateOf(catalogId);
    if (state === undefined) {
      return notConnected;
    }
    if (state === "needs_sign_in") {
      return signInRequired;
    }
    await ledger.enterNeedsSignIn(catalogId, note);
    const credentials = await this.dependencies.credentials(ownerId);
    await credentials.forgetTokens(catalogId);
    await tellNeedsSignIn(ownerId, catalogId);
    return signInRequired;
  }

  private async refreshInQueue(
    entry: McpCatalogEntry,
    ownerId: string,
    rejectedAccessToken: string | undefined
  ): Promise<AccessOutcome> {
    const { catalogId } = entry;
    const { ledger } = this.dependencies;
    const state = await ledger.stateOf(catalogId);
    if (state === "needs_sign_in") {
      return signInRequired;
    }
    if (state === undefined && rejectedAccessToken !== undefined) {
      return notConnected;
    }
    const credentials = await this.dependencies.credentials(ownerId);
    const tokens = await credentials.tokens(catalogId);
    if (tokens === undefined) {
      return rejectedAccessToken === undefined
        ? token(undefined)
        : this.enterNeedsSignIn(entry, ownerId, {
            phase: "request",
            reason: "unauthorized",
            httpStatus: 401,
          });
    }
    if (rejectedAccessToken !== undefined) {
      if (tokens.access_token !== rejectedAccessToken) {
        return token(tokens.access_token);
      }
    } else if (!isExpiring(tokens)) {
      return token(tokens.access_token);
    }
    const client = await credentials.client(catalogId);
    if (tokens.refresh_token === undefined) {
      return this.enterNeedsSignIn(entry, ownerId, {
        phase: "refresh",
        reason: "no_refresh_token",
      });
    }
    if (client?.tokenEndpoint === undefined) {
      return this.enterNeedsSignIn(entry, ownerId, {
        phase: "refresh",
        reason: "no_token_endpoint",
      });
    }
    const outcome = await refreshTokens({
      send: this.dependencies.send,
      client,
      tokenEndpoint: client.tokenEndpoint,
      refreshToken: tokens.refresh_token,
      serverUrl: entry.serverUrl,
    });
    if (outcome._tag === "Rejected") {
      return this.enterNeedsSignIn(entry, ownerId, {
        phase: "refresh",
        reason: "invalid_grant",
        httpStatus: outcome.httpStatus,
      });
    }
    if (outcome._tag === "Unavailable") {
      await ledger.recordError(catalogId, {
        phase: "refresh",
        reason: "unavailable",
        ...(outcome.httpStatus === undefined
          ? {}
          : { httpStatus: outcome.httpStatus }),
      });
      return unavailable;
    }
    return this.save(credentials, catalogId, outcome.tokens);
  }

  private async save(
    credentials: SealedCredentials,
    catalogId: string,
    refreshed: StoredTokens
  ): Promise<AccessOutcome> {
    try {
      await credentials.saveTokens(catalogId, refreshed);
      return token(refreshed.access_token);
    } catch (error) {
      await this.dependencies.ledger.recordError(catalogId, {
        phase: "refresh",
        reason: "failed",
      });
      await Effect.runPromise(
        Effect.logError("The refreshed MCP tokens were not saved", error)
      );
      return unavailable;
    }
  }
}
