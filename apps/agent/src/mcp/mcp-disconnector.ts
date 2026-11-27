import type { KeyedQueue } from "./keyed-queue.ts";
import { mcpEntryOf } from "./mcp-catalog.ts";
import type { McpCatalog } from "./mcp-catalog.ts";
import type { McpConnectionLedger } from "./mcp-connection-ledger.ts";
import type {
  McpDisconnectOutcome,
  McpRevocation,
} from "./mcp-hub-contract.ts";
import type { FetchFunction } from "./mcp-outbound-guard.ts";
import type { McpServerConnector } from "./mcp-server-connector.ts";
import { pendingOAuthOf } from "./oauth-start.ts";
import {
  connectionRecordKey,
  lastErrorKey,
  latestExchangeKey,
  pendingOAuthKeyPrefix,
  settledOAuthKeyPrefix,
  settledOAuthOf,
} from "./oauth-storage-keys.ts";
import { revokeTokens } from "./oauth-token-revocation.ts";
import { credentialKeysOf } from "./sealed-credentials.ts";
import type {
  SealedCredentials,
  StoredClient,
  StoredTokens,
} from "./sealed-credentials.ts";

const closeDeadlineMillis = 3000;

const revocationOfEarlierDisconnect = (
  earlier: "pending" | McpRevocation | undefined
): McpRevocation => {
  if (earlier === undefined) {
    return "not_attempted";
  }
  return earlier === "pending" ? "failed" : earlier;
};

export interface McpDisconnectorDependencies {
  readonly catalog: McpCatalog;
  readonly entryQueue: KeyedQueue;
  readonly ledger: McpConnectionLedger;
  readonly connector: McpServerConnector;
  readonly storage: DurableObjectStorage;
  readonly send: FetchFunction;
  readonly ownerId: () => string;
  readonly credentials: (ownerId: string) => Promise<SealedCredentials>;
}

interface HeldCredentials {
  readonly tokens: StoredTokens;
  readonly client: StoredClient;
  readonly revocationEndpoint: string;
}

export class McpDisconnector {
  private readonly dependencies: McpDisconnectorDependencies;

  constructor(dependencies: McpDisconnectorDependencies) {
    this.dependencies = dependencies;
  }

  disconnect(catalogId: string): Promise<McpDisconnectOutcome> {
    if (mcpEntryOf(this.dependencies.catalog, catalogId) === undefined) {
      return Promise.resolve({ outcome: "unknown_catalog_entry" });
    }
    return this.dependencies.entryQueue.run(catalogId, () =>
      this.disconnectInQueue(catalogId)
    );
  }

  private async heldCredentialsOf(
    catalogId: string
  ): Promise<HeldCredentials | undefined> {
    try {
      const credentials = await this.dependencies.credentials(
        this.dependencies.ownerId()
      );
      const tokens = await credentials.tokens(catalogId);
      const client = await credentials.client(catalogId);
      return tokens === undefined || client?.revocationEndpoint === undefined
        ? undefined
        : { tokens, client, revocationEndpoint: client.revocationEndpoint };
    } catch {
      return undefined;
    }
  }

  private async keysOf(catalogId: string) {
    const { storage } = this.dependencies;
    const pending = [...(await storage.list({ prefix: pendingOAuthKeyPrefix }))]
      .filter(([, value]) => pendingOAuthOf(value)?.catalogId === catalogId)
      .map(([key]) => key);
    const settled = [...(await storage.list({ prefix: settledOAuthKeyPrefix }))]
      .filter(([, value]) => settledOAuthOf(value)?.catalogId === catalogId)
      .map(([key]) => key);
    return [
      ...credentialKeysOf(catalogId),
      connectionRecordKey(catalogId),
      lastErrorKey(catalogId),
      latestExchangeKey(catalogId),
      ...pending,
      ...settled,
    ];
  }

  private async disconnectInQueue(
    catalogId: string
  ): Promise<McpDisconnectOutcome> {
    const { storage, connector, send, ledger } = this.dependencies;
    const held = await this.heldCredentialsOf(catalogId);
    const earlier = await ledger.removalOf(catalogId);
    await storage.delete(await this.keysOf(catalogId));
    await ledger.markBeingRemoved(catalogId, "pending");
    await connector.forget(catalogId, closeDeadlineMillis);
    const revocation: McpRevocation =
      held === undefined
        ? revocationOfEarlierDisconnect(earlier)
        : await revokeTokens({
            send,
            client: held.client,
            revocationEndpoint: held.revocationEndpoint,
            tokens: held.tokens,
          });
    await ledger.markBeingRemoved(catalogId, revocation);
    return { outcome: "disconnected", revocation };
  }

  acknowledgeRemoval(catalogId: string): Promise<void> {
    return this.dependencies.entryQueue.run(catalogId, async () => {
      await this.dependencies.ledger.clearBeingRemoved(catalogId);
    });
  }

  async removeAll(): Promise<void> {
    await Promise.all(
      this.dependencies.catalog.map((entry) =>
        this.dependencies.entryQueue.run(entry.catalogId, () =>
          this.dependencies.connector.forget(
            entry.catalogId,
            closeDeadlineMillis
          )
        )
      )
    );
    await this.dependencies.storage.deleteAll();
  }
}
