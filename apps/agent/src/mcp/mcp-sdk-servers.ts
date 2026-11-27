import { Effect, Option, Schema } from "effect";

import type { LazyMcpClientManager } from "./lazy-mcp-client-manager.ts";
import { within } from "./mcp-within.ts";

const IdsSchema = Schema.Array(Schema.String);

const decodeIds = Schema.decodeUnknownOption(IdsSchema);

const idsKey = (catalogId: string) => `sdk-servers:${catalogId}`;

export const sdkIdOf = (catalogId: string, epoch: number) =>
  `${catalogId}:${epoch}`;

export class McpSdkServers {
  private readonly manager: LazyMcpClientManager;

  private readonly storage: DurableObjectStorage;

  private updates: Promise<unknown> = Promise.resolve();

  constructor(manager: LazyMcpClientManager, storage: DurableObjectStorage) {
    this.manager = manager;
    this.storage = storage;
  }

  isReady(sdkId: string) {
    return this.manager.mcpConnections[sdkId]?.connectionState === "ready";
  }

  private async trackedIds(catalogId: string) {
    return Option.getOrElse(
      decodeIds(await this.storage.get(idsKey(catalogId))),
      () => []
    );
  }

  private update(
    catalogId: string,
    change: (ids: readonly string[]) => string[]
  ) {
    const updated = this.updates.then(async () => {
      const ids = change(await this.trackedIds(catalogId));
      await (ids.length === 0
        ? this.storage.delete(idsKey(catalogId))
        : this.storage.put(idsKey(catalogId), ids));
      return null;
    });
    this.updates = updated.catch(() => null);
    return updated;
  }

  private untrack(catalogId: string, sdkId: string) {
    return this.update(catalogId, (ids) => ids.filter((id) => id !== sdkId));
  }

  track(catalogId: string, sdkId: string) {
    return this.update(catalogId, (ids) => [
      ...ids.filter((id) => id !== sdkId),
      sdkId,
    ]);
  }

  async dropRowsWithoutConnection(catalogId: string, keepSdkId: string) {
    const ids = await this.trackedIds(catalogId);
    await Promise.all(
      ids
        .filter(
          (id) =>
            id !== keepSdkId && this.manager.mcpConnections[id] === undefined
        )
        .map((id) => this.retire(catalogId, id))
    );
  }

  private async retire(catalogId: string, sdkId: string) {
    try {
      await this.manager.removeServer(sdkId);
      await this.untrack(catalogId, sdkId);
    } catch (error) {
      await Effect.runPromise(
        Effect.logWarning("The MCP server record was not removed", error)
      );
    }
  }

  close(catalogId: string, sdkId: string): Promise<void> {
    const closed =
      this.manager.mcpConnections[sdkId] === undefined
        ? Promise.resolve()
        : this.manager.closeConnection(sdkId);
    closed
      .catch(() => null)
      .then(() => this.retire(catalogId, sdkId))
      .catch(() => null);
    return closed;
  }

  async closeWithin(catalogId: string, sdkId: string, deadlineMillis: number) {
    try {
      await within(this.close(catalogId, sdkId), deadlineMillis);
    } catch {
      await Effect.runPromise(
        Effect.logWarning("The MCP connection did not close cleanly")
      );
    }
  }
}
