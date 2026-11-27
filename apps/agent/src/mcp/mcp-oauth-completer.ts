import { DateTime } from "effect";

import { mcpEntryOf } from "./mcp-catalog.ts";
import type { McpCatalog, McpCatalogEntry } from "./mcp-catalog.ts";
import type {
  McpCallbackOutcome,
  McpOAuthCallback,
} from "./mcp-hub-contract.ts";
import type { FetchFunction } from "./mcp-outbound-guard.ts";
import { pendingOAuthOf } from "./oauth-start.ts";
import type { PendingOAuth } from "./oauth-start.ts";
import {
  pendingOAuthKeyPrefix,
  settledOAuthKeyPrefix,
  settledOAuthOf,
} from "./oauth-storage-keys.ts";
import type { SettledOAuth } from "./oauth-storage-keys.ts";
import { exchangeCode } from "./oauth-token-exchange.ts";
import type { SealedCredentials } from "./sealed-credentials.ts";

const settledLifetimeMillis = 15 * 60 * 1000;

const nowMillis = () => DateTime.toEpochMillis(DateTime.nowUnsafe());

export interface McpCompletion {
  readonly entry: McpCatalogEntry;
  readonly ownerId: string;
  readonly completionId: string;
  readonly accountLabel: string | undefined;
}

export interface McpOAuthCompleterDependencies {
  readonly catalog: McpCatalog;
  readonly send: FetchFunction;
  readonly storage: DurableObjectStorage;
  readonly credentials: (ownerId: string) => Promise<SealedCredentials>;
  readonly connect: (
    completion: McpCompletion
  ) => Promise<"connected" | "failed">;
  readonly markFailed: (ownerId: string, catalogId: string) => Promise<void>;
}

const hasText = (value: string | undefined): value is string =>
  value !== undefined && value.length > 0;

const issuerAgrees = (pending: PendingOAuth, iss: string | undefined) =>
  iss === undefined ? !pending.issuerIsRequired : iss === pending.issuer;

export class McpOAuthCompleter {
  private readonly dependencies: McpOAuthCompleterDependencies;

  private readonly running = new Map<string, Promise<McpCallbackOutcome>>();

  constructor(dependencies: McpOAuthCompleterDependencies) {
    this.dependencies = dependencies;
  }

  complete(returned: McpOAuthCallback): Promise<McpCallbackOutcome> {
    const running = this.running.get(returned.nonce);
    if (running !== undefined) {
      return running;
    }
    const started = this.run(returned).finally(() => {
      this.running.delete(returned.nonce);
    });
    this.running.set(returned.nonce, started);
    return started;
  }

  private async replayOf(nonce: string): Promise<McpCallbackOutcome> {
    const { storage, catalog } = this.dependencies;
    const settled = settledOAuthOf(
      await storage.get(`${settledOAuthKeyPrefix}${nonce}`)
    );
    const entry =
      settled === undefined || settled.expiresAtMillis <= nowMillis()
        ? undefined
        : mcpEntryOf(catalog, settled.catalogId);
    if (settled === undefined || entry === undefined) {
      return { outcome: "not_started" };
    }
    const serverName = entry.displayName;
    const recorded = await storage.get<true>(`connection:${entry.catalogId}`);
    if (recorded === true) {
      return { outcome: "connected", serverName };
    }
    const connected = await this.dependencies.connect({
      entry,
      ownerId: settled.ownerId,
      completionId: nonce,
      accountLabel: settled.accountLabel,
    });
    return { outcome: connected, serverName };
  }

  private async run(returned: McpOAuthCallback): Promise<McpCallbackOutcome> {
    const { storage, catalog } = this.dependencies;
    const key = `${pendingOAuthKeyPrefix}${returned.nonce}`;
    const pending = pendingOAuthOf(await storage.get(key));
    if (pending === undefined || pending.expiresAtMillis <= nowMillis()) {
      return this.replayOf(returned.nonce);
    }
    const entry = mcpEntryOf(catalog, pending.catalogId);
    if (entry === undefined || !issuerAgrees(pending, returned.iss)) {
      return { outcome: "not_started" };
    }
    const { code, error } = returned;
    if (!hasText(code) && !hasText(error)) {
      return { outcome: "not_started" };
    }
    await storage.delete(key);
    const serverName = entry.displayName;
    if (hasText(error) || !hasText(code)) {
      await this.dependencies.markFailed(pending.ownerId, entry.catalogId);
      return { outcome: "denied", serverName };
    }
    const exchanged = await this.exchange(entry, pending, {
      nonce: returned.nonce,
      code,
    });
    if (exchanged._tag === "Failed") {
      await this.dependencies.markFailed(pending.ownerId, entry.catalogId);
      return { outcome: "failed", serverName };
    }
    const connected = await this.dependencies.connect({
      entry,
      ownerId: pending.ownerId,
      completionId: returned.nonce,
      accountLabel: exchanged.label,
    });
    if (connected === "failed") {
      return { outcome: "failed", serverName };
    }
    return { outcome: "connected", serverName };
  }

  private async exchange(
    entry: McpCatalogEntry,
    pending: PendingOAuth,
    granted: { readonly nonce: string; readonly code: string }
  ): Promise<
    | { readonly _tag: "Failed" }
    | { readonly _tag: "Exchanged"; readonly label: string | undefined }
  > {
    try {
      const credentials = await this.dependencies.credentials(pending.ownerId);
      const exchanged = await exchangeCode({
        send: this.dependencies.send,
        tokenEndpoint: pending.tokenEndpoint,
        clientId: pending.clientId,
        redirectUrl: pending.redirectUrl,
        serverUrl: entry.serverUrl,
        code: granted.code,
        codeVerifier: await credentials.openVerifier(
          entry.catalogId,
          granted.nonce,
          pending.sealedCodeVerifier
        ),
      });
      await this.dependencies.storage.put(
        await credentials.sealedEntries(entry.catalogId, exchanged.tokens, {
          client_id: pending.clientId,
          redirectUrl: pending.redirectUrl,
        })
      );
      await this.dependencies.storage.put<SettledOAuth>(
        `${settledOAuthKeyPrefix}${granted.nonce}`,
        {
          ownerId: pending.ownerId,
          catalogId: entry.catalogId,
          ...(exchanged.accountLabel === undefined
            ? {}
            : { accountLabel: exchanged.accountLabel }),
          expiresAtMillis: nowMillis() + settledLifetimeMillis,
        }
      );
      return { _tag: "Exchanged", label: exchanged.accountLabel };
    } catch {
      return { _tag: "Failed" };
    }
  }
}
