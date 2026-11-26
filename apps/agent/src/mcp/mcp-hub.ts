import { Lifecycle } from "agents/lifecycle";
import { DurableObject } from "cloudflare:workers";
import { Effect, Option } from "effect";

import { OwnerIdSchema } from "../owner-id.ts";
import { personalAgentFor } from "../personal-agent/personal-agent.ts";
import { LazyMcpClientManager } from "./lazy-mcp-client-manager.ts";
import { mcpEntryOf } from "./mcp-catalog.ts";
import type { McpCatalog, McpCatalogEntry } from "./mcp-catalog.ts";
import type {
  McpAddConnectionOutcome,
  McpCallOutcome,
  McpCallRequest,
  McpHubRpc,
} from "./mcp-hub-contract.ts";
import { resultTextOf, toolCopyOf } from "./mcp-hub-results.ts";
import { guardedFetch } from "./mcp-outbound-guard.ts";
import type { FetchFunction } from "./mcp-outbound-guard.ts";
import { mcpCatalogFor } from "./mcp-test-catalog.ts";

const sendFromWorker: FetchFunction = (input, init) => fetch(input, init);

const within = <Value>(work: Promise<Value>, millis: number) =>
  Effect.runPromise(
    Effect.tryPromise(() => work).pipe(Effect.timeoutOption(millis))
  );

const allowedOriginsOf = (env: Env): readonly string[] =>
  env.MCP_TEST_SERVER_URL === ""
    ? []
    : [new URL(env.MCP_TEST_SERVER_URL).origin];

export class McpHub extends DurableObject<Env> implements McpHubRpc {
  protected readonly send: FetchFunction = sendFromWorker;

  protected readonly catalog: McpCatalog = mcpCatalogFor(this.env);

  protected readonly allowedOrigins = allowedOriginsOf(this.env);

  private readonly manager = new LazyMcpClientManager("billy-mcp-hub", "1.0.0");

  readonly lifecycle = Lifecycle.install(this).use(this.manager);

  private readonly connecting = new Map<string, Promise<void>>();

  private async registerAndConnect({
    catalogId,
    serverUrl,
    displayName,
  }: McpCatalogEntry) {
    await this.manager.registerServer(catalogId, {
      url: serverUrl,
      name: displayName,
      transport: {
        type: "streamable-http",
        fetch: guardedFetch(this.send, this.allowedOrigins),
      },
    });
    const connected = await this.manager.connectToServer(catalogId);
    if (connected.state !== "connected") {
      throw new Error("The MCP server is not connected");
    }
    const discovered = await this.manager.discoverIfConnected(catalogId);
    if (discovered?.success !== true) {
      throw new Error("The MCP server did not list its tools");
    }
  }

  private connectOnce(entry: McpCatalogEntry) {
    const existing = this.connecting.get(entry.catalogId);
    if (existing !== undefined) {
      return existing;
    }
    const started = this.registerAndConnect(entry).finally(() => {
      this.connecting.delete(entry.catalogId);
    });
    this.connecting.set(entry.catalogId, started);
    return started;
  }

  private async ensureConnected(
    entry: McpCatalogEntry,
    connectTimeoutMillis: number
  ): Promise<"connected" | "timed_out"> {
    await this.lifecycle.start();
    if (
      this.manager.mcpConnections[entry.catalogId]?.connectionState === "ready"
    ) {
      return "connected";
    }
    const connected = await within(
      this.connectOnce(entry),
      connectTimeoutMillis
    );
    return Option.isSome(connected) ? "connected" : "timed_out";
  }

  private connectionsSql() {
    const { sql } = this.ctx.storage;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS mcp_hub_connections (catalog_id TEXT PRIMARY KEY)"
    );
    return sql;
  }

  private isRecorded(catalogId: string) {
    return (
      this.connectionsSql()
        .exec(
          "SELECT catalog_id FROM mcp_hub_connections WHERE catalog_id = ?",
          catalogId
        )
        .toArray().length > 0
    );
  }

  async addConnection(
    catalogId: string,
    connectTimeoutMillis: number
  ): Promise<McpAddConnectionOutcome> {
    const entry = mcpEntryOf(this.catalog, catalogId);
    if (entry === undefined) {
      return { outcome: "unknown_catalog_entry" };
    }
    const agent = await personalAgentFor(
      this.env.PERSONAL_AGENT,
      OwnerIdSchema.make(this.ctx.id.name ?? "")
    );
    try {
      if (
        (await this.ensureConnected(entry, connectTimeoutMillis)) ===
        "timed_out"
      ) {
        throw new Error("The MCP server did not connect in time");
      }
      this.connectionsSql().exec(
        "INSERT OR IGNORE INTO mcp_hub_connections (catalog_id) VALUES (?)",
        catalogId
      );
      await agent.receiveMcpToolCatalog(
        catalogId,
        this.manager.listTools({ serverId: catalogId }).map(toolCopyOf)
      );
      await agent.receiveMcpConnectionState(catalogId, "ready");
      return { outcome: "added" };
    } catch {
      await agent.receiveMcpConnectionState(catalogId, "failed");
      return { outcome: "failed" };
    }
  }

  async callTool(request: McpCallRequest): Promise<McpCallOutcome> {
    const entry = mcpEntryOf(this.catalog, request.catalogId);
    if (entry === undefined || !this.isRecorded(request.catalogId)) {
      return { _tag: "Failed", reason: "not_connected" };
    }
    try {
      if (
        (await this.ensureConnected(entry, request.connectTimeoutMillis)) ===
        "timed_out"
      ) {
        return { _tag: "Failed", reason: "timed_out" };
      }
      const result = await within(
        this.manager.callTool(
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
        text: resultTextOf(result.value.content),
        structured: result.value.structuredContent ?? null,
      };
    } catch {
      return { _tag: "Failed", reason: "failed" };
    }
  }
}
