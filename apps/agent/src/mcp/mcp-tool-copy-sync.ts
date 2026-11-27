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
  readonly epochOf: (catalogId: string) => number;
  readonly isLive: (catalogId: string, epoch: number) => boolean;
  readonly copiesOf: (
    catalogId: string,
    epoch: number
  ) => readonly McpToolCopy[];
  readonly refreshTools: (
    catalogId: string,
    ownerId: string,
    options: { readonly timeoutMillis: number; readonly epoch: number }
  ) => Promise<"refreshed" | "failed" | "timed_out">;
  readonly closeLive: (catalogId: string, epoch: number) => Promise<void>;
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

  remember(catalogId: string, copies: readonly McpToolCopy[]) {
    this.sent.set(catalogId, JSON.stringify(copies));
  }

  async sendWhenChanged(catalogId: string, epoch: number) {
    const { ledger, isLive, copiesOf, deliver } = this.dependencies;
    if (!(await ledger.isReady(catalogId)) || !isLive(catalogId, epoch)) {
      return;
    }
    const copies = copiesOf(catalogId, epoch);
    const serialized = JSON.stringify(copies);
    if (this.sent.get(catalogId) === serialized) {
      return;
    }
    await deliver(catalogId, copies);
    this.sent.set(catalogId, serialized);
  }

  private async syncOne(catalogId: string) {
    const { ledger, entryQueue, isLive, epochOf } = this.dependencies;
    const epoch = epochOf(catalogId);
    if (isLive(catalogId, epoch) && (await ledger.isReady(catalogId))) {
      await entryQueue.run(catalogId, () =>
        this.sendWhenChanged(catalogId, epoch)
      );
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
    const { entryQueue, ledger, refreshTools, epochOf } = this.dependencies;
    const epoch = epochOf(catalogId);
    if (!(await ledger.isReady(catalogId))) {
      return { outcome: "not_ready" };
    }
    const refreshed = await refreshTools(catalogId, ownerId, {
      timeoutMillis: connectTimeoutMillis,
      epoch,
    });
    return entryQueue.run(catalogId, async (): Promise<McpRefreshOutcome> => {
      if (!(await ledger.isReady(catalogId))) {
        await this.dependencies.closeLive(catalogId, epoch);
        return { outcome: "not_ready" };
      }
      if (refreshed === "refreshed") {
        await this.sendWhenChanged(catalogId, epoch);
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
