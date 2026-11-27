import { Effect, Option } from "effect";

import type { LazyMcpClientManager } from "./lazy-mcp-client-manager.ts";
import { within } from "./mcp-within.ts";

export class McpConnectionCloser {
  private readonly manager: LazyMcpClientManager;

  private readonly closing = new Map<string, Promise<void>>();

  constructor(manager: LazyMcpClientManager) {
    this.manager = manager;
  }

  isClosing(catalogId: string) {
    return this.closing.has(catalogId);
  }

  async closeWithin(catalogId: string, deadlineMillis: number) {
    try {
      const closed = await within(this.closeIfOpen(catalogId), deadlineMillis);
      if (Option.isNone(closed)) {
        this.closing.delete(catalogId);
      }
    } catch {
      await Effect.runPromise(
        Effect.logWarning("The MCP connection did not close cleanly")
      );
    }
  }

  closeIfOpen(catalogId: string) {
    const pending = this.closing.get(catalogId);
    if (pending !== undefined) {
      return pending;
    }
    if (this.manager.mcpConnections[catalogId] === undefined) {
      return Promise.resolve();
    }
    const closed: Promise<void> = this.manager
      .closeConnection(catalogId)
      .finally(() => {
        if (this.closing.get(catalogId) === closed) {
          this.closing.delete(catalogId);
        }
      });
    this.closing.set(catalogId, closed);
    return closed;
  }
}
