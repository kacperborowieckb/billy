import { Option } from "effect";

import type { LazyMcpClientManager } from "./lazy-mcp-client-manager.ts";
import type { AdmittedCall } from "./mcp-admitted-call.ts";
import { authorizedFetch } from "./mcp-authorized-fetch.ts";
import type { McpCatalogEntry } from "./mcp-catalog.ts";
import type { McpConnectionHealth } from "./mcp-connection-health.ts";
import type { McpCallOutcome } from "./mcp-hub-contract.ts";
import { resultOutcomeOf, toolCopyOf } from "./mcp-hub-results.ts";
import { guardedFetch } from "./mcp-outbound-guard.ts";
import type { FetchFunction } from "./mcp-outbound-guard.ts";
import { McpQueueHolds } from "./mcp-queue-holds.ts";
import { McpSdkServers, sdkIdOf } from "./mcp-sdk-servers.ts";
import { within } from "./mcp-within.ts";
import type { SealedCredentials } from "./sealed-credentials.ts";
import { SealedOAuthProvider } from "./sealed-oauth-provider.ts";

export interface McpServerConnectorDependencies {
  readonly manager: LazyMcpClientManager;
  readonly storage: DurableObjectStorage;
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

  private readonly queueHolds = new McpQueueHolds();

  private readonly epochs = new Map<string, number>();

  private readonly servers: McpSdkServers;

  constructor(dependencies: McpServerConnectorDependencies) {
    this.dependencies = dependencies;
    this.servers = new McpSdkServers(
      dependencies.manager,
      dependencies.storage
    );
  }

  epochOf(catalogId: string) {
    return this.epochs.get(catalogId) ?? 0;
  }

  private currentSdkId(catalogId: string) {
    return sdkIdOf(catalogId, this.epochOf(catalogId));
  }

  isLive(catalogId: string) {
    return this.servers.isReady(this.currentSdkId(catalogId));
  }

  private async registerAndConnect(
    entry: McpCatalogEntry,
    ownerId: string,
    epoch: number
  ) {
    const { manager, send, allowedOrigins, credentials, health } =
      this.dependencies;
    const { catalogId } = entry;
    const sdkId = sdkIdOf(catalogId, epoch);
    const sealedCredentials = await credentials(ownerId);
    if (this.epochOf(catalogId) !== epoch) {
      throw new Error("The MCP Connection was removed before it connected");
    }
    await this.servers.dropRowsWithoutConnection(catalogId, sdkId);
    await this.servers.track(catalogId, sdkId);
    await manager.registerServer(sdkId, {
      url: entry.serverUrl,
      name: entry.displayName,
      transport: {
        type: "streamable-http",
        fetch: authorizedFetch({
          send: guardedFetch(send, allowedOrigins),
          entry,
          ownerId,
          health,
          queueWaitsOnConnect: () => this.queueHolds.isHeld(catalogId),
        }),
        authProvider: new SealedOAuthProvider(
          sealedCredentials,
          catalogId,
          "Billy"
        ),
      },
    });
    const connected = await manager.connectToServer(sdkId);
    if (connected.state !== "connected") {
      throw new Error("The MCP server is not connected");
    }
    const discovered = await manager.discoverIfConnected(sdkId);
    if (discovered?.success !== true) {
      throw new Error("The MCP server did not list its tools");
    }
    if (this.epochOf(catalogId) !== epoch) {
      await this.servers.close(catalogId, sdkId);
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

  whileQueueHeld<Value>(catalogId: string, work: () => Promise<Value>) {
    return this.queueHolds.whileHeld(catalogId, work);
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
    if (this.isLive(entry.catalogId)) {
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
        this.currentSdkId(entry.catalogId)
      );
      return discovered?.success === true ? "refreshed" : "failed";
    } catch {
      return "failed";
    }
  }

  close(catalogId: string) {
    return this.servers.close(catalogId, this.currentSdkId(catalogId));
  }

  closeWhileQueueHeld(catalogId: string, deadlineMillis: number) {
    return this.closeSdkServerWhileQueueHeld(
      catalogId,
      this.currentSdkId(catalogId),
      deadlineMillis
    );
  }

  private closeSdkServerWhileQueueHeld(
    catalogId: string,
    sdkId: string,
    deadlineMillis: number
  ) {
    return this.whileQueueHeld(catalogId, () =>
      this.servers.closeWithin(catalogId, sdkId, deadlineMillis)
    );
  }

  async forget(catalogId: string, deadlineMillis: number) {
    const closedSdkId = this.currentSdkId(catalogId);
    this.epochs.set(catalogId, this.epochOf(catalogId) + 1);
    const running = this.connecting.get(catalogId);
    if (running !== undefined) {
      await within(
        running.catch(() => null),
        deadlineMillis
      ).catch(() => null);
    }
    await this.closeSdkServerWhileQueueHeld(
      catalogId,
      closedSdkId,
      deadlineMillis
    );
  }

  toolCopiesOf(catalogId: string) {
    return this.dependencies.manager
      .listTools({ serverId: this.currentSdkId(catalogId) })
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
            serverId: this.currentSdkId(request.catalogId),
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
      return resultOutcomeOf(result.value);
    } catch {
      return { _tag: "Failed", reason: "failed" };
    }
  }
}
