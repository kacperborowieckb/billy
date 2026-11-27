import { Effect, Option, Schema } from "effect";

import type { LazyMcpClientManager } from "./lazy-mcp-client-manager.ts";
import { within } from "./mcp-within.ts";

const decodeIds = Schema.decodeUnknownOption(Schema.Array(Schema.String));

const idsKey = (catalogId: string) => `sdk-servers:${catalogId}`;

export const sdkIdOf = (catalogId: string, epoch: number) =>
  `${catalogId}:${epoch}`;

export class McpSdkServers {
  private readonly manager: LazyMcpClientManager;

  private readonly storage: DurableObjectStorage;

  private readonly epochs = new Map<string, number>();

  private readonly connecting = new Map<string, Promise<void>>();

  private readonly closing = new Set<string>();

  private readonly retiring = new Map<string, Promise<null>>();

  private updates: Promise<unknown> = Promise.resolve();

  constructor(manager: LazyMcpClientManager, storage: DurableObjectStorage) {
    this.manager = manager;
    this.storage = storage;
  }

  epochOf(catalogId: string) {
    return this.epochs.get(catalogId) ?? 0;
  }

  currentId(catalogId: string) {
    return sdkIdOf(catalogId, this.epochOf(catalogId));
  }

  isReady(sdkId: string) {
    return this.manager.mcpConnections[sdkId]?.connectionState === "ready";
  }

  advanceFrom(catalogId: string, epoch: number) {
    if (this.epochOf(catalogId) === epoch) {
      this.epochs.set(catalogId, epoch + 1);
    }
    this.connecting.delete(sdkIdOf(catalogId, epoch));
  }

  connectOnce(sdkId: string, start: () => Promise<void>) {
    const existing = this.connecting.get(sdkId);
    if (existing !== undefined) {
      return existing;
    }
    const started: Promise<void> = start().finally(() => {
      if (this.connecting.get(sdkId) === started) {
        this.connecting.delete(sdkId);
      }
    });
    this.connecting.set(sdkId, started);
    return started;
  }

  connectOf(sdkId: string) {
    return this.connecting.get(sdkId);
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

  track(catalogId: string, sdkId: string) {
    return this.update(catalogId, (ids) => [
      ...ids.filter((id) => id !== sdkId),
      sdkId,
    ]);
  }

  async dropStale(catalogId: string, currentSdkId: string) {
    const ids = await this.trackedIds(catalogId);
    for (const id of ids) {
      if (id !== currentSdkId && !this.closing.has(id)) {
        this.retire(catalogId, id);
      }
    }
  }

  private async removeRecord(catalogId: string, sdkId: string) {
    try {
      await this.manager.removeServer(sdkId);
      await this.update(catalogId, (ids) => ids.filter((id) => id !== sdkId));
    } catch (error) {
      await Effect.runPromise(
        Effect.logWarning("The MCP server record was not removed", error)
      );
    } finally {
      this.retiring.delete(sdkId);
    }
    return null;
  }

  retire(catalogId: string, sdkId: string) {
    const existing = this.retiring.get(sdkId);
    if (existing !== undefined) {
      return existing;
    }
    const retired = this.removeRecord(catalogId, sdkId);
    this.retiring.set(sdkId, retired);
    return retired;
  }

  close(sdkId: string): Promise<void> {
    return this.manager.mcpConnections[sdkId] === undefined
      ? Promise.resolve()
      : this.manager.closeConnection(sdkId);
  }

  async closeWithin(catalogId: string, sdkId: string, deadlineMillis: number) {
    this.closing.add(sdkId);
    const closed = this.close(sdkId);
    closed
      .catch(() => null)
      .then(() => {
        this.closing.delete(sdkId);
        return this.retire(catalogId, sdkId);
      })
      .catch(() => null);
    try {
      const settled = await within(closed, deadlineMillis);
      if (Option.isNone(settled)) {
        this.closing.delete(sdkId);
        this.retire(catalogId, sdkId);
      }
    } catch {
      await Effect.runPromise(
        Effect.logWarning("The MCP connection did not close cleanly")
      );
    }
  }
}
