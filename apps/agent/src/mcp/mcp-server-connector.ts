import { Effect, Option } from "effect";

import type { LazyMcpClientManager } from "./lazy-mcp-client-manager.ts";
import type { AdmittedCall } from "./mcp-admitted-call.ts";
import { authorizedFetch } from "./mcp-authorized-fetch.ts";
import type { McpCatalogEntry } from "./mcp-catalog.ts";
import { McpConnectionCloser } from "./mcp-connection-closer.ts";
import type { McpConnectionHealth } from "./mcp-connection-health.ts";
import type { McpCallOutcome } from "./mcp-hub-contract.ts";
import { resultTextOf, toolCopyOf } from "./mcp-hub-results.ts";
import { guardedFetch } from "./mcp-outbound-guard.ts";
import type { FetchFunction } from "./mcp-outbound-guard.ts";
import { within } from "./mcp-within.ts";
import type { SealedCredentials } from "./sealed-credentials.ts";
import { SealedOAuthProvider } from "./sealed-oauth-provider.ts";

export interface McpServerConnectorDependencies {
  readonly manager: LazyMcpClientManager;
  readonly start: () => Promise<unknown>;
  readonly send: FetchFunction;
  readonly allowedOrigins: readonly string[];
  readonly credentials: (ownerId: string) => Promise<SealedCredentials>;
  readonly health: McpConnectionHealth;
}

export interface ConnectOptions {
  readonly timeoutMillis: number;
  readonly holdsEntryQueue?: boolean;
  readonly epoch?: number;
}

export class McpServerConnector {
  private readonly dependencies: McpServerConnectorDependencies;

  private readonly connecting = new Map<string, Promise<void>>();

  private readonly queueHolds = new Map<string, number>();

  private readonly epochs = new Map<string, number>();

  private readonly closer: McpConnectionCloser;

  constructor(dependencies: McpServerConnectorDependencies) {
    this.dependencies = dependencies;
    this.closer = new McpConnectionCloser(dependencies.manager);
  }

  epochOf(catalogId: string) {
    return this.epochs.get(catalogId) ?? 0;
  }

  private async registerAndConnect(
    entry: McpCatalogEntry,
    ownerId: string,
    epoch: number
  ) {
    const { manager, send, allowedOrigins, credentials, health } =
      this.dependencies;
    const { catalogId } = entry;
    const sealedCredentials = await credentials(ownerId);
    if (this.epochOf(catalogId) !== epoch || this.closer.isClosing(catalogId)) {
      throw new Error("The MCP Connection was removed before it connected");
    }
    await manager.registerServer(catalogId, {
      url: entry.serverUrl,
      name: entry.displayName,
      transport: {
        type: "streamable-http",
        fetch: authorizedFetch({
          send: guardedFetch(send, allowedOrigins),
          entry,
          ownerId,
          health,
          queueWaitsOnConnect: () => (this.queueHolds.get(catalogId) ?? 0) > 0,
        }),
        authProvider: new SealedOAuthProvider(
          sealedCredentials,
          catalogId,
          "Billy"
        ),
      },
    });
    const connected = await manager.connectToServer(catalogId);
    if (connected.state !== "connected") {
      throw new Error("The MCP server is not connected");
    }
    const discovered = await manager.discoverIfConnected(catalogId);
    if (discovered?.success !== true) {
      throw new Error("The MCP server did not list its tools");
    }
    if (this.epochOf(catalogId) !== epoch) {
      await this.closer.closeIfOpen(catalogId);
      throw new Error("The MCP Connection was removed while it connected");
    }
  }

  private connectOnce(entry: McpCatalogEntry, ownerId: string, epoch: number) {
    const existing = this.connecting.get(entry.catalogId);
    if (existing !== undefined) {
      return existing;
    }
    const started: Promise<void> = this.registerAndConnect(
      entry,
      ownerId,
      epoch
    ).finally(() => {
      if (this.connecting.get(entry.catalogId) === started) {
        this.connecting.delete(entry.catalogId);
      }
    });
    this.connecting.set(entry.catalogId, started);
    return started;
  }

  ensureConnected(
    entry: McpCatalogEntry,
    ownerId: string,
    {
      timeoutMillis,
      holdsEntryQueue = false,
      epoch = this.epochOf(entry.catalogId),
    }: ConnectOptions
  ): Promise<"connected" | "timed_out"> {
    if (!holdsEntryQueue) {
      return this.connectWhenNeeded(entry, ownerId, { timeoutMillis, epoch });
    }
    return this.whileQueueHeld(entry.catalogId, () =>
      this.connectWhenNeeded(entry, ownerId, { timeoutMillis, epoch })
    );
  }

  async whileQueueHeld<Value>(catalogId: string, work: () => Promise<Value>) {
    this.queueHolds.set(catalogId, (this.queueHolds.get(catalogId) ?? 0) + 1);
    try {
      return await work();
    } finally {
      const left = (this.queueHolds.get(catalogId) ?? 1) - 1;
      if (left === 0) {
        this.queueHolds.delete(catalogId);
      } else {
        this.queueHolds.set(catalogId, left);
      }
    }
  }

  private async connectWhenNeeded(
    entry: McpCatalogEntry,
    ownerId: string,
    {
      timeoutMillis: connectTimeoutMillis,
      epoch = this.epochOf(entry.catalogId),
    }: ConnectOptions
  ): Promise<"connected" | "timed_out"> {
    await this.dependencies.start();
    if (
      this.dependencies.manager.mcpConnections[entry.catalogId]
        ?.connectionState === "ready"
    ) {
      return "connected";
    }
    const connected = await within(
      this.connectOnce(entry, ownerId, epoch),
      connectTimeoutMillis
    );
    return Option.isSome(connected) ? "connected" : "timed_out";
  }

  async refreshTools(
    entry: McpCatalogEntry,
    ownerId: string,
    connectTimeoutMillis: number
  ): Promise<"refreshed" | "failed" | "timed_out"> {
    try {
      const connected = await this.connectWhenNeeded(entry, ownerId, {
        timeoutMillis: connectTimeoutMillis,
      });
      if (connected === "timed_out") {
        return "timed_out";
      }
      const discovered = await this.dependencies.manager.discoverIfConnected(
        entry.catalogId
      );
      return discovered?.success === true ? "refreshed" : "failed";
    } catch {
      return "failed";
    }
  }

  async close(catalogId: string) {
    await this.dependencies.manager.closeConnection(catalogId);
  }

  async closeWhileQueueHeld(catalogId: string, deadlineMillis: number) {
    await this.whileQueueHeld(catalogId, async () => {
      try {
        await within(this.closer.closeIfOpen(catalogId), deadlineMillis);
      } catch {
        await Effect.runPromise(
          Effect.logWarning("The MCP connection did not close cleanly")
        );
      }
    });
  }

  async forget(catalogId: string, deadlineMillis: number) {
    this.epochs.set(catalogId, this.epochOf(catalogId) + 1);
    const running = this.connecting.get(catalogId);
    if (running !== undefined) {
      await within(
        running.catch(() => null),
        deadlineMillis
      ).catch(() => null);
    }
    await this.closeWhileQueueHeld(catalogId, deadlineMillis);
  }

  toolCopiesOf(catalogId: string) {
    return this.dependencies.manager
      .listTools({ serverId: catalogId })
      .map(toolCopyOf);
  }

  async callTool(
    entry: McpCatalogEntry,
    ownerId: string,
    { request, epoch }: AdmittedCall
  ): Promise<McpCallOutcome> {
    try {
      if (
        (await this.ensureConnected(entry, ownerId, {
          timeoutMillis: request.connectTimeoutMillis,
          epoch,
        })) === "timed_out"
      ) {
        return { _tag: "Failed", reason: "timed_out" };
      }
      if (this.epochOf(request.catalogId) !== epoch) {
        return { _tag: "Failed", reason: "not_connected" };
      }
      const result = await within(
        this.dependencies.manager.callTool(
          {
            serverId: request.catalogId,
            name: request.tool,
            arguments: { ...request.arguments },
          },
          { timeout: request.callTimeoutMillis }
        ),
        request.callTimeoutMillis
      );
      if (Option.isNone(result)) {
        return { _tag: "Failed", reason: "timed_out" };
      }
      return {
        _tag: "Result",
        isError: result.value.isError === true,
        text: resultTextOf(
          result.value.content,
          result.value.structuredContent
        ),
        structured: result.value.structuredContent ?? null,
      };
    } catch {
      return { _tag: "Failed", reason: "failed" };
    }
  }
}
