import { Effect, Option } from "effect";

import type { LazyMcpClientManager } from "./lazy-mcp-client-manager.ts";
import type { McpCatalogEntry } from "./mcp-catalog.ts";
import type { McpCallOutcome, McpCallRequest } from "./mcp-hub-contract.ts";
import { resultTextOf, toolCopyOf } from "./mcp-hub-results.ts";
import { guardedFetch } from "./mcp-outbound-guard.ts";
import type { FetchFunction } from "./mcp-outbound-guard.ts";
import type { SealedCredentials } from "./sealed-credentials.ts";
import { SealedOAuthProvider } from "./sealed-oauth-provider.ts";

const within = <Value>(work: Promise<Value>, millis: number) =>
  Effect.runPromise(
    Effect.tryPromise(() => work).pipe(Effect.timeoutOption(millis))
  );

export interface McpServerConnectorDependencies {
  readonly manager: LazyMcpClientManager;
  readonly start: () => Promise<unknown>;
  readonly send: FetchFunction;
  readonly allowedOrigins: readonly string[];
  readonly credentials: (ownerId: string) => Promise<SealedCredentials>;
}

export class McpServerConnector {
  private readonly dependencies: McpServerConnectorDependencies;

  private readonly connecting = new Map<string, Promise<void>>();

  constructor(dependencies: McpServerConnectorDependencies) {
    this.dependencies = dependencies;
  }

  private async registerAndConnect(entry: McpCatalogEntry, ownerId: string) {
    const { manager, send, allowedOrigins, credentials } = this.dependencies;
    const { catalogId } = entry;
    await manager.registerServer(catalogId, {
      url: entry.serverUrl,
      name: entry.displayName,
      transport: {
        type: "streamable-http",
        fetch: guardedFetch(send, allowedOrigins),
        authProvider: new SealedOAuthProvider(
          await credentials(ownerId),
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
  }

  private connectOnce(entry: McpCatalogEntry, ownerId: string) {
    const existing = this.connecting.get(entry.catalogId);
    if (existing !== undefined) {
      return existing;
    }
    const started = this.registerAndConnect(entry, ownerId).finally(() => {
      this.connecting.delete(entry.catalogId);
    });
    this.connecting.set(entry.catalogId, started);
    return started;
  }

  async ensureConnected(
    entry: McpCatalogEntry,
    ownerId: string,
    connectTimeoutMillis: number
  ): Promise<"connected" | "timed_out"> {
    await this.dependencies.start();
    if (
      this.dependencies.manager.mcpConnections[entry.catalogId]
        ?.connectionState === "ready"
    ) {
      return "connected";
    }
    const connected = await within(
      this.connectOnce(entry, ownerId),
      connectTimeoutMillis
    );
    return Option.isSome(connected) ? "connected" : "timed_out";
  }

  async close(catalogId: string) {
    await this.dependencies.manager.closeConnection(catalogId);
  }

  toolCopiesOf(catalogId: string) {
    return this.dependencies.manager
      .listTools({ serverId: catalogId })
      .map(toolCopyOf);
  }

  async callTool(
    entry: McpCatalogEntry,
    ownerId: string,
    request: McpCallRequest
  ): Promise<McpCallOutcome> {
    try {
      if (
        (await this.ensureConnected(
          entry,
          ownerId,
          request.connectTimeoutMillis
        )) === "timed_out"
      ) {
        return { _tag: "Failed", reason: "timed_out" };
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
