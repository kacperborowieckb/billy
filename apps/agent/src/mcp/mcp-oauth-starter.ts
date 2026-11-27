import { DateTime } from "effect";

import type { KeyedQueue } from "./keyed-queue.ts";
import { mcpEntryOf } from "./mcp-catalog.ts";
import type { McpCatalog, McpCatalogEntry } from "./mcp-catalog.ts";
import type {
  McpConsentOutcome,
  McpOAuthRequest,
  McpOAuthStartOutcome,
} from "./mcp-hub-contract.ts";
import type { FetchFunction } from "./mcp-outbound-guard.ts";
import { discoverOAuth } from "./oauth-discovery.ts";
import { pendingOAuthOf, startOAuth } from "./oauth-start.ts";
import type { PendingOAuth } from "./oauth-start.ts";
import {
  pendingOAuthKeyPrefix,
  expiryOf,
  settledOAuthKeyPrefix,
  settledOAuthOf,
  usedProofKeyPrefix,
} from "./oauth-storage-keys.ts";
import type { SealedCredentials } from "./sealed-credentials.ts";

const oauthStartLifetimeMillis = 10 * 60 * 1000;

const usedProofLifetimeMillis = 15 * 60 * 1000;

const nowMillis = () => DateTime.toEpochMillis(DateTime.nowUnsafe());

export interface McpOAuthStarterDependencies {
  readonly catalog: McpCatalog;
  readonly send: FetchFunction;
  readonly allowedOrigins: readonly string[];
  readonly storage: DurableObjectStorage;
  readonly routingId: string;
  readonly ownerId: () => string;
  readonly credentials: (ownerId: string) => Promise<SealedCredentials>;
  readonly entryQueue: KeyedQueue;
  readonly isReady: (catalogId: string) => Promise<boolean>;
  readonly isBeingRemoved: (catalogId: string) => Promise<boolean>;
  readonly entryEpochOf: (catalogId: string) => number;
  readonly markAuthenticating: (catalogId: string) => Promise<void>;
}

type Checked =
  | {
      readonly _tag: "Refused";
      readonly outcome:
        | "unknown_catalog_entry"
        | "already_connected"
        | "unavailable";
    }
  | { readonly _tag: "Allowed"; readonly entry: McpCatalogEntry };

export class McpOAuthStarter {
  private readonly dependencies: McpOAuthStarterDependencies;

  constructor(dependencies: McpOAuthStarterDependencies) {
    this.dependencies = dependencies;
  }

  private async check(request: McpOAuthRequest): Promise<Checked> {
    const entry = mcpEntryOf(this.dependencies.catalog, request.catalogId);
    if (entry === undefined) {
      return { _tag: "Refused", outcome: "unknown_catalog_entry" };
    }
    if (await this.dependencies.isReady(request.catalogId)) {
      return { _tag: "Refused", outcome: "already_connected" };
    }
    if (await this.dependencies.isBeingRemoved(request.catalogId)) {
      return { _tag: "Refused", outcome: "unavailable" };
    }
    return { _tag: "Allowed", entry };
  }

  private discover(entry: McpCatalogEntry, request: McpOAuthRequest) {
    const { send, allowedOrigins } = this.dependencies;
    return discoverOAuth({
      send,
      allowedOrigins,
      serverUrl: entry.serverUrl,
      clientMetadataUrl: request.clientMetadataUrl,
    });
  }

  async describeConsent(request: McpOAuthRequest): Promise<McpConsentOutcome> {
    const checked = await this.check(request);
    if (checked._tag === "Refused") {
      return { outcome: checked.outcome };
    }
    try {
      const { server, clientMode } = await this.discover(
        checked.entry,
        request
      );
      return {
        outcome: "ready_to_consent",
        serverName: checked.entry.displayName,
        authorizationServer: new URL(server.authorization_endpoint).origin,
        clientMode,
      };
    } catch {
      return { outcome: "unavailable" };
    }
  }

  async startOAuth(request: McpOAuthRequest): Promise<McpOAuthStartOutcome> {
    const epoch = this.dependencies.entryEpochOf(request.catalogId);
    const checked = await this.check(request);
    if (checked._tag === "Refused") {
      return { outcome: checked.outcome };
    }
    const { entry } = checked;
    try {
      const discovery = await this.discover(entry, request);
      const ownerId = this.dependencies.ownerId();
      const credentials = await this.dependencies.credentials(ownerId);
      const proof = await this.useUpProof(entry.catalogId, request.proofId);
      if (proof !== "fresh") {
        return { outcome: proof };
      }
      const started = await startOAuth({
        send: this.dependencies.send,
        discovery,
        catalogId: entry.catalogId,
        serverUrl: entry.serverUrl,
        redirectUrl: request.redirectUrl,
        clientMetadataUrl: request.clientMetadataUrl,
        clientName: "Billy",
        ownerId,
        routingId: this.dependencies.routingId,
        sealVerifier: (nonce, verifier) =>
          credentials.sealVerifier(entry.catalogId, nonce, verifier),
        sealClientSecret: (nonce, secret) =>
          credentials.sealClientSecret(entry.catalogId, nonce, secret),
        nowMillis: nowMillis(),
        lifetimeMillis: oauthStartLifetimeMillis,
      });
      return await this.dependencies.entryQueue.run(
        entry.catalogId,
        async () => {
          if (await this.dependencies.isReady(entry.catalogId)) {
            return { outcome: "already_connected" } as const;
          }
          if (
            (await this.dependencies.isBeingRemoved(entry.catalogId)) ||
            this.dependencies.entryEpochOf(entry.catalogId) !== epoch
          ) {
            return { outcome: "unavailable" } as const;
          }
          await this.dependencies.storage.put<PendingOAuth>(
            `${pendingOAuthKeyPrefix}${started.nonce}`,
            started.pending
          );
          await this.forgetExpired();
          await this.dependencies.markAuthenticating(entry.catalogId);
          return {
            outcome: "redirect",
            authorizationUrl: started.authorizationUrl,
          } as const;
        }
      );
    } catch {
      return { outcome: "unavailable" };
    }
  }

  private useUpProof(catalogId: string, proofId: string) {
    const { storage, entryQueue, isBeingRemoved } = this.dependencies;
    const key = `${usedProofKeyPrefix}${proofId}`;
    return entryQueue.run(
      catalogId,
      async (): Promise<"fresh" | "proof_used" | "unavailable"> => {
        if (await isBeingRemoved(catalogId)) {
          return "unavailable";
        }
        if ((await storage.get<number>(key)) !== undefined) {
          return "proof_used";
        }
        await storage.put<number>(key, nowMillis() + usedProofLifetimeMillis);
        return "fresh";
      }
    );
  }

  private async forgetExpired() {
    const { storage } = this.dependencies;
    const now = nowMillis();
    const isExpired = (expiresAtMillis: number | undefined) =>
      expiresAtMillis === undefined || expiresAtMillis <= now;
    const expiredKeysOf = async (
      prefix: string,
      readExpiry: (stored: unknown) => number | undefined
    ) => {
      const stored = await storage.list({ prefix });
      return [...stored]
        .filter(([, value]) => isExpired(readExpiry(value)))
        .map(([key]) => key);
    };
    const expired = [
      ...(await expiredKeysOf(
        pendingOAuthKeyPrefix,
        (stored) => pendingOAuthOf(stored)?.expiresAtMillis
      )),
      ...(await expiredKeysOf(usedProofKeyPrefix, expiryOf)),
      ...(await expiredKeysOf(
        settledOAuthKeyPrefix,
        (stored) => settledOAuthOf(stored)?.expiresAtMillis
      )),
    ];
    if (expired.length > 0) {
      await storage.delete(expired);
    }
  }
}
