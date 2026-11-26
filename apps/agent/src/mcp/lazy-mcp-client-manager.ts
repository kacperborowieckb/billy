import { MCPClientManager } from "agents/mcp/client";

export class LazyMcpClientManager extends MCPClientManager {
  // oxlint-disable-next-line class-methods-use-this
  override restoreConnectionsFromStorage(): Promise<void> {
    return Promise.resolve();
  }
}
