import { Effect } from "effect";

import type { KeyedQueue } from "./keyed-queue.ts";
import { mcpEntryOf } from "./mcp-catalog.ts";
import type { McpCatalog } from "./mcp-catalog.ts";
import type { McpConnectionLedger } from "./mcp-connection-ledger.ts";
import type { McpRefreshOutcome } from "./mcp-hub-contract.ts";
import type { McpToolCopy } from "./mcp-tool-copy.ts";

export interface McpToolCopySyncDependencies {
  readonly catalog: McpCatalog;
  readonly entryQueue: KeyedQueue;
  readonly ledger: McpConnectionLedger;
  readonly isLive: (catalogId: string) => boolean;
  readonly copiesOf: (catalogId: string) => readonly McpToolCopy[];
  readonly refreshTools: (
    catalogId: string,
    ownerId: string,
    connectTimeoutMillis: number
  ) => Promise<"refreshed" | "failed" | "timed_out">;
  readonly closeLive: (catalogId: string) => Promise<void>;
  readonly deliver: (
    catalogId: string,
    copies: readonly McpToolCopy[]
  ) => Promise<void>;
}

export class McpToolCopySync {
  private readonly dependencies: McpToolCopySyncDependencies;

  private readonly sent = new Map<string, string>();

  constructor(dependencies: McpToolCopySyncDependencies) {
    this.dependencies = dependencies;
  }

  remember(catalogId: string) {
    this.sent.set(
      catalogId,
      JSON.stringify(this.dependencies.copiesOf(catalogId))
    );
  }

  async sendWhenChanged(catalogId: string) {
    if (!(await this.dependencies.ledger.isReady(catalogId))) {
      return;
    }
    const copies = this.dependencies.copiesOf(catalogId);
    const serialized = JSON.stringify(copies);
    if (this.sent.get(catalogId) === serialized) {
      return;
    }
    await this.dependencies.deliver(catalogId, copies);
    this.sent.set(catalogId, serialized);
  }

  private async syncOne(catalogId: string) {
    const { ledger, entryQueue, isLive } = this.dependencies;
    if (isLive(catalogId) && (await ledger.isReady(catalogId))) {
      await entryQueue.run(catalogId, () => this.sendWhenChanged(catalogId));
    }
  }

  refresh(
    catalogId: string,
    ownerId: string,
    connectTimeoutMillis: number
  ): Promise<McpRefreshOutcome> {
    const { catalog } = this.dependencies;
    if (mcpEntryOf(catalog, catalogId) === undefined) {
      return Promise.resolve({ outcome: "unknown_catalog_entry" });
    }
    return this.refreshOutsideQueue(catalogId, ownerId, connectTimeoutMillis);
  }

  private async refreshOutsideQueue(
    catalogId: string,
    ownerId: string,
    connectTimeoutMillis: number
  ): Promise<McpRefreshOutcome> {
    const { entryQueue, ledger, refreshTools } = this.dependencies;
    if (!(await ledger.isReady(catalogId))) {
      return { outcome: "not_ready" };
    }
    const refreshed = await refreshTools(
      catalogId,
      ownerId,
      connectTimeoutMillis
    );
    return entryQueue.run(catalogId, async (): Promise<McpRefreshOutcome> => {
      if (!(await ledger.isReady(catalogId))) {
        await this.dependencies.closeLive(catalogId);
        return { outcome: "not_ready" };
      }
      if (refreshed === "refreshed") {
        await this.sendWhenChanged(catalogId);
      }
      return { outcome: refreshed };
    });
  }

  async onServerStateChanged() {
    try {
      await Promise.all(
        this.dependencies.catalog.map(({ catalogId }) =>
          this.syncOne(catalogId)
        )
      );
    } catch (error) {
      await Effect.runPromise(
        Effect.logWarning("The MCP tool catalog copy was not synced", error)
      );
    }
  }
}
