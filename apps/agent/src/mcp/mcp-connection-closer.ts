import type { LazyMcpClientManager } from "./lazy-mcp-client-manager.ts";

export class McpConnectionCloser {
  private readonly manager: LazyMcpClientManager;

  private readonly closing = new Map<string, Promise<void>>();

  constructor(manager: LazyMcpClientManager) {
    this.manager = manager;
  }

  isClosing(catalogId: string) {
    return this.closing.has(catalogId);
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
